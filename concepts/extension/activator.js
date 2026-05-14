const vscode = require('vscode');
const path = require('path');
const { EditorService } = require('../editor/service');
const { SidebarService } = require('../sidebar/service');
const { SidebarTreeProvider } = require('../sidebar/provider');
const { LocaleService } = require('../locale/service');
const { TranslationService } = require('../translation/service');
const { ExtractionService } = require('../extraction/service');
const { buildRenameEdit, validateRenameKey } = require('../providers/renameProvider');
const { getKeyAtPosition } = require('../utils/i18n-detection');

class ExtensionActivator {
    constructor() {
        this.localeService = new LocaleService();
        this.translationService = new TranslationService();
        this.editorService = new EditorService(this.translationService, this.localeService);
        this.sidebarService = new SidebarService(this.translationService, this.localeService);
        this.sidebarTreeProvider = new SidebarTreeProvider(this.sidebarService, this.localeService, this.translationService);
        this.extractionService = new ExtractionService(this.localeService, this.translationService);
        this.disposables = [];
        this.translationFileWatchers = [];
        this.documentUpdateTimeouts = new Map();
    }

    getDebounceDelay() {
        const config = vscode.workspace.getConfiguration('elementaryWatson');
        return config.get('updateDelay', 300);
    }

    isRealtimeUpdatesEnabled() {
        const config = vscode.workspace.getConfiguration('elementaryWatson');
        return config.get('realtimeUpdates', true);
    }

    debounceDocumentUpdate(documentUri, callback) {
        const existingTimeout = this.documentUpdateTimeouts.get(documentUri);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
        }

        const delay = this.getDebounceDelay();
        const timeout = setTimeout(() => {
            this.documentUpdateTimeouts.delete(documentUri);
            callback();
        }, delay);

        this.documentUpdateTimeouts.set(documentUri, timeout);
    }

    shouldUpdateForChange(event) {
        const changes = event.contentChanges;
        if (changes.length === 0) return false;

        for (const change of changes) {
            const lineChange = change.range.end.line - change.range.start.line;
            const hasNewlines = change.text.includes('\n') || change.text.includes('\r');

            if (lineChange > 0 || hasNewlines) {
                return true;
            }

            const oldText = change.rangeLength > 0 ? true : false;
            const newText = change.text;

            if (oldText || newText.includes('m.') || newText.includes('()')) {
                return true;
            }
        }

        return false;
    }

    activate(context) {
        console.log('ElementaryWatson i18n companion is now active!');

        this.registerSidebar();
        this.sidebarTreeProvider.setTreeView(this.treeView);
        this.registerChangeLocaleCommand();
        this.registerInspectTranslationCommand();
        this.registerExtractTextCommand();
        this.registerSidebarCommands();
        this.registerCopyTranslationCommand();
        this.registerTranslationLabelClickCommand();
        this.registerCodeLensProvider();
        this.registerRenameKeyCommand();
        this.setupEventListeners();
        this.setupTranslationFileWatchers();
        this.processActiveEditor();

        context.subscriptions.push(...this.disposables);

        const decorationType = this.editorService.getDecorator().getDecorationType();
        if (decorationType) {
            context.subscriptions.push(decorationType);
        }
    }

    registerSidebar() {
        this.treeView = vscode.window.createTreeView('elementaryWatsonSidebar', {
            treeDataProvider: this.sidebarTreeProvider,
            showCollapseAll: false
        });

        this.disposables.push(this.treeView);
        vscode.commands.executeCommand('setContext', 'elementaryWatson.showSidebar', true);
    }

    registerSidebarCommands() {
        const openTranslationCommand = vscode.commands.registerCommand('elementaryWatson.openTranslationFile',
            async (workspacePath, locale, key) => {
                await this.sidebarService.openTranslationFile(workspacePath, locale, key);
            }
        );
        this.disposables.push(openTranslationCommand);
    }

    registerChangeLocaleCommand() {
        const changeLocaleCommand = vscode.commands.registerCommand('elementaryWatson.changeLocale', async () => {
            const currentLocale = this.localeService.getCurrentLocale();
            const newLocale = await vscode.window.showInputBox({
                prompt: 'Enter the locale code (e.g., en, es, fr)',
                value: currentLocale,
                placeHolder: 'en'
            });

            if (newLocale && newLocale !== currentLocale) {
                await this.localeService.updateLocale(newLocale);
                vscode.window.showInformationMessage(`Locale changed to ${newLocale}`);
                await this.processActiveEditor();
            }
        });
        this.disposables.push(changeLocaleCommand);
    }

    registerInspectTranslationCommand() {
        const inspectCommand = vscode.commands.registerCommand(
            'elementaryWatson.inspectTranslation',
            async () => {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor) return;
                const result = this.editorService.getCodeLensProvider.getTranslationResultAtPosition(
                    activeEditor.document, activeEditor.selection.active
                );
                if (!result) {
                    vscode.window.showInformationMessage('Place the cursor on a translation call (e.g. m.someKey) to inspect it.');
                    return;
                }
                await this.inspectTranslation(result.methodName, activeEditor.document.uri.fsPath);
            }
        );
        this.disposables.push(inspectCommand);
    }

    registerExtractTextCommand() {
        const extractCommand = vscode.commands.registerCommand('elementaryWatson.extractText', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active text editor');
                return;
            }

            const document = editor.document;
            const selection = editor.selection;

            await this.extractionService.extractSelectedText(editor, document, selection);
        });
        this.disposables.push(extractCommand);
    }

    registerCopyTranslationCommand() {
        const copyTranslationCommand = vscode.commands.registerCommand('elementaryWatson.copyTranslation',
            async (translationValue) => {
                if (translationValue) {
                    await vscode.env.clipboard.writeText(translationValue);
                    vscode.window.showInformationMessage(`Copied: "${translationValue}"`);
                }
            }
        );
        this.disposables.push(copyTranslationCommand);
    }

    registerTranslationLabelClickCommand() {
        const clickLabelCommand = vscode.commands.registerCommand('elementaryWatson.clickTranslationLabel',
            async (translationKey, filePath) => {
                try {
                    await this.inspectTranslation(translationKey, filePath);
                } catch (error) {
                    console.error('Error handling translation label click:', error);
                    vscode.window.showErrorMessage(`Failed to navigate to translation: ${error.message}`);
                }
            }
        );
        this.disposables.push(clickLabelCommand);
    }

    registerCodeLensProvider() {
        const codeLensProvider = this.editorService.getCodeLensProvider();
        const codeLensDisposable = vscode.languages.registerCodeLensProvider(
            [
                { language: 'javascript', scheme: 'file' },
                { language: 'javascriptreact', scheme: 'file' },
                { language: 'typescript', scheme: 'file' },
                { language: 'typescriptreact', scheme: 'file' },
                { language: 'svelte', scheme: 'file' },
            ],
            codeLensProvider
        );
        this.disposables.push(codeLensDisposable);
    }

    registerRenameKeyCommand() {
        const cmd = vscode.commands.registerCommand('elementaryWatson.renameKey', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const { document, selection } = editor;
            const oldKey = getKeyAtPosition(document, selection.active);
            if (!oldKey) {
                vscode.window.showErrorMessage('Place the cursor on a translation key to rename it.');
                return;
            }

            const newKey = await vscode.window.showInputBox({
                prompt: 'New translation key name',
                value: oldKey,
                validateInput: validateRenameKey,
            });
            if (!newKey || newKey === oldKey) return;

            const edit = new vscode.WorkspaceEdit();
            try {
                await buildRenameEdit(edit, document, oldKey, newKey, this.translationService);
            } catch (err) {
                vscode.window.showErrorMessage(`Rename failed: ${err.message}`);
                return;
            }

            const success = await vscode.workspace.applyEdit(edit);
            if (success) {
                await this.processActiveEditor();
            } else {
                vscode.window.showErrorMessage('ElementaryWatson: workspace.applyEdit failed — no changes were made.');
            }
        });
        this.disposables.push(cmd);
    }

    setupEventListeners() {
        const saveDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
            if (this.editorService.isSupportedDocument(document)) {
                console.log(`\n💾 File saved: ${path.basename(document.uri.fsPath)}`);
                await this.editorService.processDocument(document);
                await this.sidebarTreeProvider.refresh(document);
            }
        });

        const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (editor) {
                console.log(`\n📄 Active editor changed: ${path.basename(editor.document.uri.fsPath)}`);
                if (this.editorService.isSupportedDocument(editor.document)) {
                    await this.editorService.processDocument(editor.document);
                    await this.sidebarTreeProvider.refresh(editor.document);
                } else {
                    await this.sidebarTreeProvider.refresh(editor.document);
                }
            } else {
                await this.sidebarTreeProvider.refresh(null);
            }
        });

        const documentChangeDisposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
            const document = event.document;
            const uriStr = document.uri.toString();

            if (!this.isRealtimeUpdatesEnabled()) return;
            if (!this.editorService.isSupportedDocument(document)) return;
            if (!this.shouldUpdateForChange(event)) return;

            this.debounceDocumentUpdate(uriStr, async () => {
                try {
                    if (!this.isRealtimeUpdatesEnabled()) return;
                    console.log(`\n✏️  Content change detected: ${path.basename(document.uri.fsPath)} (debounced)`);
                    await this.editorService.processDocument(document);
                    await this.sidebarTreeProvider.refresh(document);
                } catch (error) {
                    console.error('Error processing document content change:', error);
                }
            });
        });

        const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (event.affectsConfiguration('elementaryWatson.defaultLocale')) {
                await this.processActiveEditor();
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && this.editorService.isSupportedDocument(activeEditor.document)) {
                    await this.sidebarTreeProvider.refresh(activeEditor.document);
                }
            }

            if (event.affectsConfiguration('elementaryWatson.realtimeUpdates')) {
                const enabled = this.isRealtimeUpdatesEnabled();
                console.log(`🔄 Real-time updates ${enabled ? 'enabled' : 'disabled'}`);
                if (!enabled) {
                    for (const timeout of this.documentUpdateTimeouts.values()) {
                        clearTimeout(timeout);
                    }
                    this.documentUpdateTimeouts.clear();
                }
            }

            if (event.affectsConfiguration('elementaryWatson.updateDelay')) {
                const delay = this.getDebounceDelay();
                console.log(`⏱️  Update delay changed to ${delay}ms`);
            }

            if (event.affectsConfiguration('elementaryWatson.enableCodeLens')) {
                this.editorService.getCodeLensProvider().refresh();
            }
        });

        const workspaceFoldersChangeDisposable = vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            console.log('📁 Workspace folders changed, refreshing translation file watchers');
            await this.setupTranslationFileWatchers();
        });

        this.disposables.push(
            saveDisposable,
            editorChangeDisposable,
            documentChangeDisposable,
            configChangeDisposable,
            workspaceFoldersChangeDisposable
        );
    }

    async setupTranslationFileWatchers() {
        this.disposeTranslationFileWatchers();

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        for (const folder of workspaceFolders) {
            const pattern = new vscode.RelativePattern(folder, '**/*.json');
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);

            watcher.onDidChange(async (uri) => {
                console.log(`\n📝 Translation file changed: ${path.basename(uri.fsPath)}`);
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && this.editorService.isSupportedDocument(activeEditor.document)) {
                    await this.editorService.processDocument(activeEditor.document);
                    await this.sidebarTreeProvider.refresh(activeEditor.document);
                }
            });

            watcher.onDidCreate(async (uri) => {
                console.log(`\n✨ Translation file created: ${path.basename(uri.fsPath)}`);
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && this.editorService.isSupportedDocument(activeEditor.document)) {
                    await this.editorService.processDocument(activeEditor.document);
                    await this.sidebarTreeProvider.refresh(activeEditor.document);
                }
            });

            this.translationFileWatchers.push(watcher);
        }
    }

    disposeTranslationFileWatchers() {
        for (const watcher of this.translationFileWatchers) {
            watcher.dispose();
        }
        this.translationFileWatchers = [];
    }

    async processActiveEditor() {
        if (vscode.window.activeTextEditor) {
            const document = vscode.window.activeTextEditor.document;
            if (this.editorService.isSupportedDocument(document)) {
                await this.editorService.processDocument(document);
                await this.sidebarTreeProvider.refresh(document);
            }
        } else {
            await this.sidebarTreeProvider.refresh(null);
        }
    }

    async inspectTranslation(translationKey, filePath) {
        await vscode.commands.executeCommand('workbench.view.extension.elementaryWatson');

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('Cannot determine workspace folder');
            return;
        }

        const workspacePath = workspaceFolder.uri.fsPath;
        const currentLocale = this.localeService.getCurrentLocale();

        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.fsPath === filePath) {
            await this.sidebarTreeProvider.refresh(activeEditor.document, true);
        }

        await this.sidebarService.openTranslationFile(workspacePath, currentLocale, translationKey);
        console.log(`🔍 Clicked translation label: ${translationKey} (locale: ${currentLocale})`);
    }

    deactivate() {
        for (const timeout of this.documentUpdateTimeouts.values()) {
            clearTimeout(timeout);
        }
        this.documentUpdateTimeouts.clear();
        this.disposeTranslationFileWatchers();
        this.editorService.dispose();
    }
}

module.exports = { ExtensionActivator };
const vscode = require('vscode');
const path = require('path');
const { EditorService } = require('../editor/service');
const { SidebarService } = require('../sidebar/service');
const { SidebarTreeProvider } = require('../sidebar/provider');
const { LocaleService } = require('../locale/service');
const { TranslationService } = require('../translation/service');
const { ExtractionService } = require('../extraction/service');
const { TranslationKeyRenameProvider } = require('../providers/renameProvider');

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
        this._suppressWatcherRefresh = false;
    }

    /**
     * Suppress all watcher/save/change refresh handlers for `ms` milliseconds,
     * then trigger a single clean refresh of the active editor.
     * @param {number} ms
     */
    suppressWatcherRefreshFor(ms) {
        this._suppressWatcherRefresh = true;
        setTimeout(async () => {
            this._suppressWatcherRefresh = false;
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                try {
                    await this.editorService.processDocument(activeEditor.document);
                    await this.sidebarTreeProvider.refresh(activeEditor.document, false);
                    await vscode.commands.executeCommand(
                        'setContext',
                        'elementaryWatson.isCursorOnI18nCall',
                        this.editorService.getCodeLensProvider().isPositionOnI18nCall(
                            activeEditor.document,
                            activeEditor.selection.active
                        )
                    );
                } catch (err) {
                    console.error('Error during post-rename refresh:', err);
                }
            }
        }, ms);
    }

    /**
     * Get the current debounce delay from configuration
     * @returns {number} Debounce delay in milliseconds
     */
    getDebounceDelay() {
        const config = vscode.workspace.getConfiguration('elementaryWatson');
        return config.get('updateDelay', 300);
    }

    /**
     * Check if real-time updates are enabled
     * @returns {boolean} True if real-time updates are enabled
     */
    isRealtimeUpdatesEnabled() {
        const config = vscode.workspace.getConfiguration('elementaryWatson');
        return config.get('realtimeUpdates', true);
    }

    /**
     * Debounce utility for document updates
     * @param {string} documentUri - The document URI
     * @param {Function} callback - The function to execute after debounce
     */
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

    /**
     * Check if a document change might affect translation calls or their positions
     * @param {vscode.TextDocumentChangeEvent} event
     * @returns {boolean}
     */
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

    /**
     * Activate the extension
     * @param {vscode.ExtensionContext} context
     */
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
        this.registerRenameProvider();
        this.setupEventListeners();
        this.setupTranslationFileWatchers();
        this.processActiveEditor();

        context.subscriptions.push(...this.disposables);

        const decorationType = this.editorService.getDecorator().getDecorationType();
        if (decorationType) {
            context.subscriptions.push(decorationType);
        }
    }

    /**
     * Register the sidebar tree provider
     */
    registerSidebar() {
        this.treeView = vscode.window.createTreeView('elementaryWatsonSidebar', {
            treeDataProvider: this.sidebarTreeProvider,
            showCollapseAll: false
        });

        this.disposables.push(this.treeView);
        vscode.commands.executeCommand('setContext', 'elementaryWatson.showSidebar', true);
    }

    /**
     * Register sidebar-related commands
     */
    registerSidebarCommands() {
        const openTranslationCommand = vscode.commands.registerCommand('elementaryWatson.openTranslationFile',
            async (workspacePath, locale, key) => {
                await this.sidebarService.openTranslationFile(workspacePath, locale, key);
            }
        );

        this.disposables.push(openTranslationCommand);
    }

    /**
     * Register the change locale command
     */
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

    /**
     * Register the inspect translation command
     */
    registerInspectTranslationCommand() {
        const inspectCommand = vscode.commands.registerCommand('elementaryWatson.inspectTranslation', async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) return;

            const result = this.editorService.getCodeLensProvider().getTranslationResultAtPosition(
                activeEditor.document,
                activeEditor.selection.active
            );

            if (result) {
                await this.inspectTranslation(result.methodName, activeEditor.document.uri.fsPath);
            }
        });

        this.disposables.push(inspectCommand);
    }

    /**
     * Register the extract text command
     */
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

    /**
     * Register the copy translation command
     */
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

    /**
     * Register the translation label click command
     */
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

    /**
     * Register the CodeLens provider
     */
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

    /**
     * Register the rename provider
     */
    registerRenameProvider() {
        const renameProvider = new TranslationKeyRenameProvider(
            this.translationService,
            ms => this.suppressWatcherRefreshFor(ms)
        );

        const renameDisposable = vscode.languages.registerRenameProvider(
            [
                { language: 'typescript', scheme: 'file' },
                { language: 'javascript', scheme: 'file' },
                { language: 'svelte', scheme: 'file' },
            ],
            renameProvider
        );

        this.disposables.push(renameDisposable);
    }

    /**
     * Set up translation file watchers
     */
    async setupTranslationFileWatchers() {
        this.disposeTranslationFileWatchers();

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        for (const folder of workspaceFolders) {
            const workspacePath = folder.uri.fsPath;

            try {
                const pathPattern = await this.localeService.getTranslationPathPatternAsync(workspacePath);
                const globPattern = pathPattern.replace('{locale}', '*').replace(/^\.\//, '');
                const watcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(folder, globPattern)
                );

                watcher.onDidChange(async (uri) => {
                    const locale = path.basename(uri.fsPath, '.json');
                    await this.handleTranslationFileChange(locale);
                });

                watcher.onDidCreate(async (uri) => {
                    const locale = path.basename(uri.fsPath, '.json');
                    await this.handleTranslationFileChange(locale);
                });

                this.translationFileWatchers.push(watcher);
                this.disposables.push(watcher);
            } catch (error) {
                console.error('Error setting up translation file watchers:', error);
            }
        }
    }

    /**
     * Handle changes to translation files
     * @param {string} locale The locale of the changed file
     */
    async handleTranslationFileChange(locale) {
        if (this._suppressWatcherRefresh) return;

        try {
            console.log(`📝 Translation file changed for locale: ${locale}`);
            const activeEditor = vscode.window.activeTextEditor;

            const hasPreservedContext = this.sidebarTreeProvider.currentFilePath &&
                this.sidebarTreeProvider.translationData.length > 0;

            if (hasPreservedContext) {
                const preservedFilePath = this.sidebarTreeProvider.currentFilePath;
                try {
                    const preservedDocument = await vscode.workspace.openTextDocument(preservedFilePath);
                    if (activeEditor && activeEditor.document.uri.fsPath === preservedFilePath) {
                        await this.editorService.processDocument(activeEditor.document);
                    }
                    await this.sidebarTreeProvider.refresh(preservedDocument, true);
                    console.log(`🔄 Updated preserved context for: ${path.basename(preservedFilePath)}`);
                } catch (error) {
                    console.error('Error refreshing preserved context:', error);
                    this.sidebarTreeProvider._onDidChangeTreeData.fire();
                }
            } else {
                if (activeEditor && this.editorService.isSupportedDocument(activeEditor.document)) {
                    await this.editorService.processDocument(activeEditor.document);
                    await this.sidebarTreeProvider.refresh(activeEditor.document);
                }
            }
        } catch (error) {
            console.error('Error handling translation file change:', error);
        }
    }

    /**
     * Dispose of translation file watchers
     */
    disposeTranslationFileWatchers() {
        for (const watcher of this.translationFileWatchers) {
            watcher.dispose();
        }
        this.translationFileWatchers = [];
    }

    /**
     * Set up event listeners for document changes and configuration changes
     */
    setupEventListeners() {
        const saveDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
            if (this._suppressWatcherRefresh) return;
            if (this.editorService.isSupportedDocument(document)) {
                console.log(`\n💾 Save detected: ${path.basename(document.uri.fsPath)}`);

                const existingTimeout = this.documentUpdateTimeouts.get(document.uri.toString());
                if (existingTimeout) {
                    clearTimeout(existingTimeout);
                    this.documentUpdateTimeouts.delete(document.uri.toString());
                }

                await this.editorService.processDocument(document);
                await this.sidebarTreeProvider.refresh(document);
            }
        });

        const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (editor && this.editorService.isSupportedDocument(editor.document)) {
                await this.editorService.processDocument(editor.document);
                await this.sidebarTreeProvider.refresh(editor.document);
                await vscode.commands.executeCommand(
                    'setContext',
                    'elementaryWatson.isCursorOnI18nCall',
                    this.editorService.getCodeLensProvider().isPositionOnI18nCall(editor.document, editor.selection.active)
                );
            } else if (editor && await this.sidebarService.isTranslationFile(editor.document)) {
                await this.sidebarTreeProvider.refresh(editor.document);
                await vscode.commands.executeCommand('setContext', 'elementaryWatson.isCursorOnI18nCall', false);
            } else {
                await this.sidebarTreeProvider.refresh(null);
                await vscode.commands.executeCommand('setContext', 'elementaryWatson.isCursorOnI18nCall', false);
            }
        });

        const selectionChangeDisposable = vscode.window.onDidChangeTextEditorSelection(async (event) => {
            const onCall = this.editorService.getCodeLensProvider().isPositionOnI18nCall(
                event.textEditor.document,
                event.selections[0].active
            );
            await vscode.commands.executeCommand('setContext', 'elementaryWatson.isCursorOnI18nCall', onCall);
        });

        const documentChangeDisposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
            const document = event.document;

            if (this._suppressWatcherRefresh) return;
            if (!this.isRealtimeUpdatesEnabled()) return;
            if (!this.editorService.isSupportedDocument(document)) return;
            if (!this.shouldUpdateForChange(event)) return;

            this.debounceDocumentUpdate(document.uri.toString(), async () => {
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
            selectionChangeDisposable,
            documentChangeDisposable,
            configChangeDisposable,
            workspaceFoldersChangeDisposable
        );
    }

    /**
     * Process the currently active editor
     * @returns {Promise<void>}
     */
    async processActiveEditor() {
        if (vscode.window.activeTextEditor) {
            const document = vscode.window.activeTextEditor.document;
            if (this.editorService.isSupportedDocument(document)) {
                await this.editorService.processDocument(document);
                await this.sidebarTreeProvider.refresh(document);
                await vscode.commands.executeCommand(
                    'setContext',
                    'elementaryWatson.isCursorOnI18nCall',
                    this.editorService.getCodeLensProvider().isPositionOnI18nCall(document, vscode.window.activeTextEditor.selection.active)
                );
            }
        } else {
            await this.sidebarTreeProvider.refresh(null);
            await vscode.commands.executeCommand('setContext', 'elementaryWatson.isCursorOnI18nCall', false);
        }
    }

    /**
     * Inspect the translation for a key in a file.
     * @param {string} translationKey
     * @param {string} filePath
     */
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

    /**
     * Deactivate the extension
     */
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
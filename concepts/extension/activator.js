const vscode = require('vscode');
const path = require('path');
const { EditorService } = require('../editor/service');
const { SidebarService } = require('../sidebar/service');
const { SidebarTreeProvider } = require('../sidebar/provider');
const { LocaleService } = require('../locale/service');
const { TranslationService } = require('../translation/service');
const { ExtractionService } = require('../extraction/service');
const { buildRenameChanges, validateRenameKey } = require('../providers/renameProvider');
const {
    buildDeleteChanges,
    collectLocaleKeys,
    countSourceUsages,
    createDeleteKeyPlan,
    openUsageSearch,
} = require('../providers/deleteProvider');
const { getKeyAtPosition, getKeyRangeAtPosition, getProjectRoot } = require('../utils/i18n-detection');
const { applyTextFileChanges } = require('../utils/text-edits');

class ExtensionActivator {
    constructor() {
        this.localeService = new LocaleService();
        this.translationService = new TranslationService();
        this.editorService = new EditorService(this.translationService, this.localeService);
        this.sidebarService = new SidebarService(this.translationService, this.localeService);
        this.sidebarTreeProvider = new SidebarTreeProvider(this.sidebarService, this.localeService, this.translationService);
        this.extractionService = new ExtractionService(this.localeService, this.translationService);
        this.disposables = [];
        // Debounce utilities for content change updates
        this.documentUpdateTimeouts = new Map(); // Map of document URI to timeout
        // File watchers for translation files
        this.translationFileWatchers = [];
        this._isApplyingRename = false;
        this._renameSuppressedUris = new Set();
        this._renameSuppressionTimeout = null;
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
        // Clear existing timeout for this document
        const existingTimeout = this.documentUpdateTimeouts.get(documentUri);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
        }

        // Set new timeout with current configured delay
        const delay = this.getDebounceDelay();
        const timeout = setTimeout(() => {
            this.documentUpdateTimeouts.delete(documentUri);
            callback();
        }, delay);

        this.documentUpdateTimeouts.set(documentUri, timeout);
    }

    /**
     * Check if a document change might affect translation calls or their positions
     * @param {vscode.TextDocumentChangeEvent} event - The change event
     * @returns {boolean} True if update might be needed
     */
    shouldUpdateForChange(event) {
        const changes = event.contentChanges;
        if (changes.length === 0) return false;

        // If any change affects multiple lines or contains 'm.' pattern, we should update
        for (const change of changes) {
            // Check if change spans multiple lines (affects positioning)
            const lineChange = change.range.end.line - change.range.start.line;
            const hasNewlines = change.text.includes('\n') || change.text.includes('\r');
            
            if (lineChange > 0 || hasNewlines) {
                return true; // Multi-line changes always affect positioning
            }

            // Check if the change might affect translation calls
            const oldText = change.rangeLength > 0; // Text was deleted
            const newText = change.text;
            
            if (oldText || newText.includes('m.') || newText.includes('()')) {
                return true; // Potential translation call modification
            }
        }

        return false;
    }

    beginRenameRefreshSuppression(uris) {
        this._isApplyingRename = true;
        this._renameSuppressedUris = new Set(uris);

        if (this._renameSuppressionTimeout) {
            clearTimeout(this._renameSuppressionTimeout);
            this._renameSuppressionTimeout = null;
        }

        for (const uri of uris) {
            const timeout = this.documentUpdateTimeouts.get(uri);
            if (timeout) {
                clearTimeout(timeout);
                this.documentUpdateTimeouts.delete(uri);
            }
        }
    }

    endRenameRefreshSuppression() {
        this._isApplyingRename = false;
        this._renameSuppressionTimeout = setTimeout(() => {
            this._renameSuppressedUris.clear();
            this._renameSuppressionTimeout = null;
        }, this.getDebounceDelay() + 100);
    }

    shouldSuppressRenameRefresh(uri) {
        if (this._isApplyingRename) {
            return true;
        }

        if (!this._renameSuppressedUris.has(uri)) {
            return false;
        }

        this._renameSuppressedUris.delete(uri);
        return true;
    }

    /**
     * Activate the extension
     * @param {vscode.ExtensionContext} context The VS Code extension context
     */
    activate(context) {
        console.log('ElementaryWatson i18n companion is now active!');

        // Register the sidebar tree provider
        this.registerSidebar();
        
        // Connect tree view to provider for title updates
        this.sidebarTreeProvider.setTreeView(this.treeView);

        // Register the change locale command
        this.registerChangeLocaleCommand();

        // Register the inspect translation command
        this.registerInspectTranslationCommand();

        // Register the extract text command
        this.registerExtractTextCommand();

        // Register the rename translation key command
        this.registerRenameKeyCommand();

        // Register delete translation key commands
        this.registerDeleteKeyCommands();

        // Register sidebar commands
        this.registerSidebarCommands();

        // Register copy translation command
        this.registerCopyTranslationCommand();

        // Register translation label click command
        this.registerTranslationLabelClickCommand();

        // Register CodeLens provider
        this.registerCodeLensProvider();

        // Set up event listeners
        this.setupEventListeners();

        // Set up translation file watchers
        this.setupTranslationFileWatchers();

        // Process currently active editor on activation
        this.processActiveEditor();

        // Add all disposables to context
        context.subscriptions.push(...this.disposables);

        // Add the decorator's decoration type to disposables
        const decorationType = this.editorService.getDecorator().getDecorationType();
        if (decorationType) {
            context.subscriptions.push(decorationType);
        }
    }

    /**
     * Register the sidebar tree provider
     */
    registerSidebar() {
        // Create tree view with proper title support
        this.treeView = vscode.window.createTreeView('elementaryWatsonSidebar', {
            treeDataProvider: this.sidebarTreeProvider,
            showCollapseAll: false
        });
        
        // Add to disposables for cleanup
        this.disposables.push(this.treeView);
        
        // Set context to show sidebar
        vscode.commands.executeCommand('setContext', 'elementaryWatson.showSidebar', true);
    }

    /**
     * Register sidebar-related commands
     */
    registerSidebarCommands() {
        // Register open translation file command
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
            const currentLocale = await this.localeService.getCurrentLocale();
            const newLocale = await vscode.window.showInputBox({
                prompt: 'Enter the locale code (e.g., en, es, fr)',
                value: currentLocale,
                placeHolder: 'en'
            });

            if (newLocale && newLocale !== currentLocale) {
                await this.localeService.updateLocale(newLocale);
                vscode.window.showInformationMessage(`Locale changed to: ${newLocale}`);
                
                // Refresh all open documents
                await this.processActiveEditor();
            }
        });

        this.disposables.push(changeLocaleCommand);
    }

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

            const success = await this.extractionService.extractSelectedText(editor, document, selection);
            if (success) {
                vscode.window.showInformationMessage('Text extracted successfully to locale files');
            }
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
                { language: 'svelte', scheme: 'file' }
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
            const oldKey = getKeyAtPosition(document, selection.active, this.translationService);
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

            const keyRange = getKeyRangeAtPosition(document, selection.active, this.translationService);
            const cursorState = {
                editor,
                documentUri: document.uri.toString(),
                keyStart: document.offsetAt(keyRange.start),
                keyEnd: document.offsetAt(keyRange.end),
                cursorOffset: Math.max(0, document.offsetAt(selection.active) - document.offsetAt(keyRange.start)),
            };

            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Renaming translation key "${oldKey}"`,
                        cancellable: false,
                    },
                    async (progress) => {
                        progress.report({ message: 'Finding usages...' });
                        const changes = await buildRenameChanges(document, oldKey, newKey, this.translationService, this.localeService);
                        const changedUris = changes.map(change => change.uri.toString());

                        this.beginRenameRefreshSuppression(changedUris);
                        try {
                            progress.report({ message: 'Applying changes...' });
                            await applyTextFileChanges(changes);

                            restoreRenameCursor(cursorState, changes, newKey);

                            progress.report({ message: 'Refreshing labels...' });
                            await this.processActiveEditor();
                        } finally {
                            this.endRenameRefreshSuppression();
                        }
                    },
                );
            } catch (err) {
                vscode.window.showErrorMessage(`Rename failed: ${formatTransactionError(err)}`);
                return;
            }
        });
        this.disposables.push(cmd);
    }

    registerDeleteKeyCommands() {
        const deleteAtCursor = vscode.commands.registerCommand('elementaryWatson.deleteKey', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const key = getKeyAtPosition(editor.document, editor.selection.active, this.translationService);
            if (!key) {
                vscode.window.showErrorMessage('Place the cursor on a translation key usage to delete it.');
                return;
            }

            const projectRoot = this.getProjectRootForCommand(editor.document);
            if (!projectRoot) {
                vscode.window.showErrorMessage('Could not determine workspace for this file.');
                return;
            }

            await this.deleteTranslationKey(projectRoot, key);
        });

        const deleteByName = vscode.commands.registerCommand('elementaryWatson.deleteKeyByName', async () => {
            const projectRoot = this.getProjectRootForCommand(vscode.window.activeTextEditor?.document);
            if (!projectRoot) {
                vscode.window.showErrorMessage('Could not determine workspace.');
                return;
            }

            let keys;
            try {
                keys = await collectLocaleKeys(projectRoot, this.localeService);
            } catch (error) {
                vscode.window.showErrorMessage(`Could not load translation keys: ${error.message}`);
                return;
            }

            if (keys.length === 0) {
                vscode.window.showInformationMessage('No translation keys found.');
                return;
            }

            const selected = await vscode.window.showQuickPick(
                keys.map(key => ({ label: key })),
                { placeHolder: 'Select a translation key to delete' },
            );
            if (!selected) return;

            await this.deleteTranslationKey(projectRoot, selected.label);
        });

        this.disposables.push(deleteAtCursor, deleteByName);
    }

    getProjectRootForCommand(document) {
        if (document) {
            return getProjectRoot(document);
        }

        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
    }

    async deleteTranslationKey(projectRoot, key) {
        let plan;
        try {
            plan = await createDeleteKeyPlan(projectRoot, key, this.translationService, this.localeService);
        } catch (error) {
            vscode.window.showErrorMessage(`Delete failed: ${error.message}`);
            return;
        }

        await openUsageSearch(projectRoot, key);

        const usageCount = countSourceUsages(plan);
        const usageText = usageCount === 1 ? '1 usage' : `${usageCount} usages`;
        const localeText = plan.localeFiles.length === 1 ? '1 locale file' : `${plan.localeFiles.length} locale files`;
        const actionText = usageCount > 0
            ? `Delete "${key}" from ${localeText} and inline "${plan.inlineValue}" at ${usageText}?`
            : `Delete unused key "${key}" from ${localeText}?`;
        const confirmed = await vscode.window.showWarningMessage(
            `${actionText} Review the Search results before confirming.`,
            { modal: true },
            'Delete Translation Key',
        );
        if (confirmed !== 'Delete Translation Key') return;

        const changes = buildDeleteChanges(plan);
        try {
            await applyTextFileChanges(changes);
        } catch (error) {
            vscode.window.showErrorMessage(`Delete failed: ${formatTransactionError(error)}`);
            return;
        }

        await this.processActiveEditor();
        vscode.window.showInformationMessage(`Deleted translation key "${key}".`);
    }

    /**
     * Set up event listeners for document changes and configuration changes
     */
    setupEventListeners() {
        // Listen for document saves
        const saveDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
            if (this.editorService.isSupportedDocument(document)) {
                console.log(`\n💾 File saved: ${path.basename(document.uri.fsPath)}`);
                await this.editorService.processDocument(document);
                
                // Refresh sidebar for the saved document
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

        const selectionChangeDisposable = vscode.window.onDidChangeTextEditorSelection((event) => {
            const onCall = this.editorService.getCodeLensProvider().isPositionOnI18nCall(
                event.textEditor.document,
                event.selections[0].active
            );
            vscode.commands.executeCommand('setContext', 'elementaryWatson.isCursorOnI18nCall', onCall);
        });

        const documentChangeDisposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
            const document = event.document;
            if (this.shouldSuppressRenameRefresh(document.uri.toString())) {
                return;
            }
            
            // Check if real-time updates are enabled
            if (!this.isRealtimeUpdatesEnabled()) {
                return;
            }
            
            // Only process supported documents
            if (!this.editorService.isSupportedDocument(document)) {
                return;
            }

            // Only update if the change might affect translation calls or positions
            if (!this.shouldUpdateForChange(event)) {
                return;
            }

            // Debounce the update to avoid too frequent processing
            this.debounceDocumentUpdate(document.uri.toString(), async () => {
                try {
                    // Double-check if real-time updates are still enabled (user might have changed setting)
                    if (!this.isRealtimeUpdatesEnabled()) {
                        return;
                    }
                    
                    console.log(`\n✏️  Content change detected: ${path.basename(document.uri.fsPath)} (debounced)`);
                    await this.editorService.processDocument(document);
                    
                    // Refresh sidebar for the changed document
                    await this.sidebarTreeProvider.refresh(document);
                } catch (error) {
                    console.error('Error processing document content change:', error);
                }
            });
        });

        // Listen for configuration changes
        const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (event.affectsConfiguration('elementaryWatson.defaultLocale')) {
                // Refresh current document when locale changes
                await this.processActiveEditor();
                
                // Refresh sidebar when locale changes
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && this.editorService.isSupportedDocument(activeEditor.document)) {
                    await this.sidebarTreeProvider.refresh(activeEditor.document);
                }
            }
            
            if (event.affectsConfiguration('elementaryWatson.realtimeUpdates')) {
                const enabled = this.isRealtimeUpdatesEnabled();
                console.log(`🔄 Real-time updates ${enabled ? 'enabled' : 'disabled'}`);
                
                if (!enabled) {
                    // Clear all pending timeouts when real-time updates are disabled
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

        // Listen for workspace folder changes to refresh translation file watchers
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

    async setupTranslationFileWatchers() {
        this.disposeTranslationFileWatchers();

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        for (const folder of workspaceFolders) {
            const workspacePath = folder.uri.fsPath;
            const pathPattern = await this.localeService.getTranslationPathPatternAsync(workspacePath);
            // Replace {locale} with a glob wildcard to match all locale files
            const globPattern = pathPattern.replace('{locale}', '*').replace(/^\.\//, '');
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(folder, globPattern)
            );

            const handleChange = async (uri) => {
                if (this.shouldSuppressRenameRefresh(uri.toString())) {
                    return;
                }

                console.log(`\n📝 Translation file changed: ${path.basename(uri.fsPath)}`);
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && this.editorService.isSupportedDocument(activeEditor.document)) {
                    await this.editorService.processDocument(activeEditor.document);
                    await this.sidebarTreeProvider.refresh(activeEditor.document);
                }
            };

            watcher.onDidChange(handleChange);
            watcher.onDidCreate(handleChange);
            watcher.onDidDelete(handleChange);
            this.translationFileWatchers.push(watcher);
        }
    }

    disposeTranslationFileWatchers() {
        for (const watcher of this.translationFileWatchers) {
            watcher.dispose();
        }
        this.translationFileWatchers = [];
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
                
                // Refresh sidebar for the active document
                await this.sidebarTreeProvider.refresh(document);
                vscode.commands.executeCommand(
                    'setContext',
                    'elementaryWatson.isCursorOnI18nCall',
                    this.editorService.getCodeLensProvider().isPositionOnI18nCall(document, vscode.window.activeTextEditor.selection.active)
                );
            }
        } else {
            // Clear sidebar if no active editor
            await this.sidebarTreeProvider.refresh(null);
            vscode.commands.executeCommand('setContext', 'elementaryWatson.isCursorOnI18nCall', false);
        }
    }
    
    /**
     * Inspect translation
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
        const currentLocale = await this.localeService.getCurrentLocale();

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
        // Clear all pending timeouts
        for (const timeout of this.documentUpdateTimeouts.values()) {
            clearTimeout(timeout);
        }
        this.documentUpdateTimeouts.clear();
        if (this._renameSuppressionTimeout) {
            clearTimeout(this._renameSuppressionTimeout);
            this._renameSuppressionTimeout = null;
        }
        
        // Dispose of translation file watchers
        this.disposeTranslationFileWatchers();
        
        // Dispose of other resources
        this.editorService.dispose();
    }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatTransactionError(error) {
    if (!(error instanceof Error)) {
        return String(error);
    }

    if (error.phase === 'forward' && error.rollbackSucceeded) {
        return `${error.message}`;
    }

    if (error.phase === 'rollback') {
        return `${error.message} Review the reported file manually before retrying.`;
    }

    return error.message;
}

/**
 * @param {{ editor: vscode.TextEditor, documentUri: string, keyStart: number, keyEnd: number, cursorOffset: number }} cursorState
 * @param {Array<{ uri: vscode.Uri, edits?: Array<{ start: number, end: number, replacement: string }> }>} changes
 * @param {string} newKey
 */
function restoreRenameCursor(cursorState, changes, newKey) {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || activeEditor !== cursorState.editor || activeEditor.document.uri.toString() !== cursorState.documentUri) {
        return;
    }

    const activeChange = changes.find(change => change.uri.toString() === cursorState.documentUri);
    const edits = activeChange?.edits;
    if (!Array.isArray(edits)) {
        return;
    }

    const containingEdit = edits.find(edit => cursorState.keyStart >= edit.start && cursorState.keyEnd <= edit.end);
    if (!containingEdit) {
        return;
    }

    const keyOffsetInReplacement = containingEdit.replacement.indexOf(newKey);
    if (keyOffsetInReplacement < 0) {
        return;
    }

    const priorDelta = edits.reduce((delta, edit) => {
        if (edit.end <= containingEdit.start) {
            return delta + edit.replacement.length - (edit.end - edit.start);
        }
        return delta;
    }, 0);
    const keyStart = containingEdit.start + priorDelta + keyOffsetInReplacement;
    const cursorOffset = Math.min(cursorState.cursorOffset, newKey.length);
    const position = activeEditor.document.positionAt(keyStart + cursorOffset);
    activeEditor.selection = new vscode.Selection(position, position);
    activeEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.Default);
}

module.exports = { ExtensionActivator };

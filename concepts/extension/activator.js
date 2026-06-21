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

/** @import { Disposable, FileSystemWatcher } from 'vscode' */

/**
 * Wires together all services and registers every VS Code command, event listener, and file watcher
 * the extension needs. Also manages the rename-refresh-suppression mechanism that prevents the
 * onDidChangeTextDocument handler from interfering while the rename command applies bulk edits.
 */
class ExtensionActivator {
    constructor() {
        this.localeService = new LocaleService();
        this.translationService = new TranslationService();
        this.editorService = new EditorService(this.translationService, this.localeService);
        this.sidebarService = new SidebarService(this.translationService, this.localeService);
        this.sidebarTreeProvider = new SidebarTreeProvider(this.sidebarService, this.localeService, this.translationService);
        this.extractionService = new ExtractionService(this.localeService, this.translationService);

        /** @type {Disposable[]} */
        this.disposables = [];
        // Debounce utilities for content change updates
        this.documentUpdateTimeouts = new Map(); // Map of document URI to timeout
        // File watchers for translation files
        /** @type {FileSystemWatcher[]} */
        this.translationFileWatchers = [];

        // During a rename, the document-change handler would re-decorate mid-edit and potentially
        // throw or show stale labels. These fields suppress that processing until the rename finishes.
        this._isApplyingRename = false;
        this._renameSuppressedUris = new Set();
        this._renameSuppressionTimeout = null;

        // Guards against concurrent invocations of the async setupTranslationFileWatchers.
        // Chained calls wait for an in-progress run to complete before starting their own,
        // preventing leaked watchers when workspace folders change rapidly.
        /** @type {Promise<void> | null} */
        this._setupWatchersPromise = null;
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

    /**
     * During a rename operation, suppress document-change processing for the given URIs and
     * cancel any pending debounced updates for them. This prevents the event handler from
     * re-decorating (and possibly throwing) while bulk text edits are in flight.
     */
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

    /**
     * End the suppression window. Each URI in the suppressed set is silently skipped once so that
     * document-change events that fired during the rename don't trigger a stale refresh. The set is
     * cleared after a short timeout as a safety catch.
     */
    endRenameRefreshSuppression() {
        this._isApplyingRename = false;
        this._renameSuppressionTimeout = setTimeout(() => {
            this._renameSuppressedUris.clear();
            this._renameSuppressionTimeout = null;
        }, this.getDebounceDelay() + 100);
    }

    /**
     * During an active rename every URI is suppressed; 
     * after the rename, each URI is allowed through exactly once (the first
     * event that arrives after suppression ends) so that one post-rename refresh isn't lost.
     * @returns true if processing for this URI should be skipped.
     */
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

    /**
     * Register the "inspect translation" command, triggered via the CodeLens or command palette.
     * Switches focus to the sidebar and opens the translation file at the key's location.
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

    /**
     * Register the "rename translation key" command. Gathers the old key from the cursor position,
     * prompts for the new name, builds rename changes across source and locale files, applies them,
     * and restores the cursor position relative to the replaced key name.
     */
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

                            // After text edits shift positions, put the cursor back where the user
                            // was inside the new key name so they can continue typing if needed.

                            // This is not 100% reliable, I'm assuming due to more edits possibly shifting the code around, 
                            // but it's better than nothing
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

    /**
     * Register two delete commands: one picks up the key under the cursor, the other shows a
     * quick-pick list of every known key. Both build a plan, confirm with the user, then apply.
     */
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

    /**
     * Resolve the workspace root for a document, falling back to the first workspace folder
     * when no document is available (e.g. for palette commands that don't need an open file).
     */
    getProjectRootForCommand(document) {
        if (document) {
            return getProjectRoot(document);
        }

        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
    }

    /**
     * Build a delete plan (locale entries + source usages), ask the user to confirm, then apply.
     * Opens a search results tab so the user can review what will be inlined before confirming.
     */
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

                    // Refresh sidebar for the new active document (don't force if it's a translation file)
                    await this.sidebarTreeProvider.refresh(editor.document);
                } else {
                    await this.sidebarTreeProvider.refresh(editor.document);
                }
            } else {
                // Clear sidebar if no supported document is active and it's not a translation file
                await this.sidebarTreeProvider.refresh(null);
            }
        });

        // Update context key so that menu items (rename, delete) only show when cursor is on `m.key()`.
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

    /**
     * Watch translation files (*.json) for external changes. When a translation file is created,
     * modified, or deleted, re-process the active editor so decorations and CodeLens stay current.
     *
     * Concurrent calls are serialized via _setupWatchersPromise: if a setup is already in
     * progress, subsequent calls wait for it to finish before starting their own.
     */
    async setupTranslationFileWatchers() {
        if (this._setupWatchersPromise) {
            await this._setupWatchersPromise.catch(() => {});
            this._setupWatchersPromise = null;
        }

        const promise = this._setupTranslationFileWatchersImpl();
        this._setupWatchersPromise = promise;
        await promise;
    }

    async _setupTranslationFileWatchersImpl() {
        this.disposeTranslationFileWatchers();

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        for (const folder of workspaceFolders) {
            const workspacePath = folder.uri.fsPath;
            const pathPattern = await this.localeService.getTranslationPathPatternAsync(workspacePath);
            const globPattern = this._buildSafeGlobPattern(pathPattern);

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
            this.disposables.push(watcher);
        }
    }

    disposeTranslationFileWatchers() {
        for (const watcher of this.translationFileWatchers) {
            watcher.dispose();
        }
        this.translationFileWatchers = [];
    }

    /**
     * Convert a locale file path pattern (containing `{locale}`) into a glob pattern
     * safe for use with `createFileSystemWatcher`.
     *
     * The inlang path pattern may be as shallow as `{locale}.json`, which resolves to the
     * root-level glob `*.json`.  A root-level glob causes `RelativePattern` to place a
     * recursive inotify watch on the entire workspace folder, which can exhaust the OS
     * watch limit on large trees.  Patterns that lack a directory separator are therefore
     * scoped under `messages/` as a defensive fallback, and a warning is logged so the
     * user can adjust their inlang settings.
     *
     * @param {string} pathPattern – e.g. `./messages/{locale}.json` or `{locale}.json`
     * @returns {string} A glob pattern suitable for `new RelativePattern(folder, …)`.
     */
    _buildSafeGlobPattern(pathPattern) {
        let glob = pathPattern.replace('{locale}', '*').replace(/^\.\//, '');
        if (!glob.includes('/')) {
            console.warn(
                `Translation path pattern "${pathPattern}" resolves to root-level glob "${glob}". ` +
                `Scoping under "messages/" to avoid a recursive workspace-root watch. ` +
                `Set a more specific pathPattern in project.inlang/settings.json to silence this.`
            );
            glob = `messages/${glob}`;
        }
        return glob;
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
 * @typedef {Object} TransactionError
 * @property {'forward' | 'rollback'} phase
 * @property {boolean} [rollbackSucceeded]
 * @property {string} message
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatTransactionError(error) {
    if (!(error instanceof Error)) {
        return String(error);
    }

    const txError = /** @type {TransactionError & Error} */ (error);

    if (txError.phase === 'forward' && txError.rollbackSucceeded) {
        return `${txError.message}`;
    }

    if (txError.phase === 'rollback') {
        return `${txError.message} Review the reported file manually before retrying.`;
    }

    return error.message;
}

/**
 * @typedef {Object} CursorState
 * @property {vscode.TextEditor} editor
 * @property {string} documentUri
 * @property {number} keyStart
 * @property {number} keyEnd
 * @property {number} cursorOffset
 *
 * @typedef {Object} TextEdit
 * @property {number} start
 * @property {number} end
 * @property {string} replacement
 *
 * @typedef {Object} FileChange
 * @property {vscode.Uri} uri
 * @property {TextEdit[]} [edits]
 */

/**
 * After rename edits shift text positions, restore the cursor to the same visual offset within
 * the newly-inserted key name. Only applies if the user's cursor was on the renamed key.
 * @param {CursorState} cursorState
 * @param {FileChange[]} changes
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

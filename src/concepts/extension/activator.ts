import * as vscode from 'vscode';
import * as path from 'path';
import { EditorService } from '../editor/service';
import { LocaleService } from '../locale/service';
import { ExtractionService } from '../extraction/service';
import { SidebarService } from '../sidebar/service';
import { ProjectSelectorProvider } from '../sidebar/project-provider';
import { TranslationKeysProvider } from '../sidebar/translation-keys-provider';
import { ProjectService } from '../project/service';
import { TranslationRenameProvider } from '../editor/rename-provider';

type DocumentUpdateCallback = () => Promise<void>;

/**
 * Extension activator that manages the lifecycle and event handling
 */
export class ExtensionActivator {
  private editorService: EditorService;
  private localeService: LocaleService;
  private extractionService: ExtractionService;
  private sidebarService: SidebarService;
  private projectService: ProjectService;
  private projectSelectorProvider: ProjectSelectorProvider;
  private translationKeysProvider: TranslationKeysProvider;
  private disposables: vscode.Disposable[];
  private projectSelectorView: vscode.TreeView<vscode.TreeItem> | null;
  private translationKeysView: vscode.TreeView<vscode.TreeItem> | null;
  private documentUpdateTimeouts: Map<string, NodeJS.Timeout>;
  private DEBOUNCE_DELAY: number;
  private translationFileWatchers: vscode.FileSystemWatcher[];
  private translationRenameProvider: TranslationRenameProvider;

  constructor() {
    this.editorService = new EditorService();
    this.localeService = new LocaleService();
    this.extractionService = new ExtractionService();
    this.sidebarService = new SidebarService();
    this.projectService = new ProjectService();
    this.projectSelectorProvider = new ProjectSelectorProvider();
    this.translationKeysProvider = new TranslationKeysProvider(this.sidebarService);
    this.disposables = [];
    this.projectSelectorView = null;
    this.translationKeysView = null;
    this.documentUpdateTimeouts = new Map();
    this.DEBOUNCE_DELAY = 300;
    this.translationFileWatchers = [];
    this.translationRenameProvider = new TranslationRenameProvider();
  }

  /**
   * Get the current debounce delay from configuration
   * @returns Debounce delay in milliseconds
   */
  getDebounceDelay(): number {
    const config = vscode.workspace.getConfiguration('poirot');
    return config.get<number>('updateDelay', 300);
  }

  /**
   * Check if real-time updates are enabled
   * @returns True if real-time updates are enabled
   */
  isRealtimeUpdatesEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('poirot');
    return config.get<boolean>('realtimeUpdates', true);
  }

  /**
   * Debounce utility for document updates
   * @param documentUri The document URI
   * @param callback The function to execute after debounce
   */
  debounceDocumentUpdate(documentUri: string, callback: DocumentUpdateCallback): void {
    // Clear existing timeout for this document
    const existingTimeout = this.documentUpdateTimeouts.get(documentUri);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout with current configured delay
    const delay = this.getDebounceDelay();
    const timeout = setTimeout(async () => {
      this.documentUpdateTimeouts.delete(documentUri);
      await callback();
    }, delay);

    this.documentUpdateTimeouts.set(documentUri, timeout);
  }

  /**
   * Check if a document change might affect translation calls or their positions
   * @param event The change event
   * @returns True if update might be needed
   */
  shouldUpdateForChange(event: vscode.TextDocumentChangeEvent): boolean {
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
      const oldText = change.rangeLength > 0 ? true : false; // Text was deleted
      const newText = change.text;

      if (oldText || newText.includes('m.') || newText.includes('()')) {
        return true; // Potential translation call modification
      }
    }

    return false;
  }

  /**
   * Activate the extension
   * @param context The VS Code extension context
   */
  activate(context: vscode.ExtensionContext): void {
    console.log('Poirot i18n companion is now active!');

    // Register the sidebar views
    this.registerSidebar();

    // Initialize project selector view
    this.projectSelectorProvider.refresh();

    // Register the change locale command
    this.registerChangeLocaleCommand();

    // Register the extract text command
    this.registerExtractTextCommand();

    // Register project selection command
    this.registerProjectSelectionCommand();

    // Register sidebar commands
    this.registerSidebarCommands();

    // Register translation label click command
    this.registerTranslationLabelClickCommand();

    // Register right-click inspect translation command
    this.registerInspectTranslationAtCursorCommand();

    // Register CodeLens provider
    this.registerCodeLensProvider();

    // Register rename provider
    this.registerRenameProvider();

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
   * Register both sidebar views
   */
  private registerSidebar(): void {
    // Register project selector view
    this.projectSelectorView = vscode.window.createTreeView('poirotProjectSelector', {
      treeDataProvider: this.projectSelectorProvider,
      showCollapseAll: false,
    });

    // Register translation keys view
    this.translationKeysView = vscode.window.createTreeView('poirotTranslationKeys', {
      treeDataProvider: this.translationKeysProvider,
      showCollapseAll: false,
    });

    // Add to disposables for cleanup
    this.disposables.push(this.projectSelectorView, this.translationKeysView);

    // Connect translation keys view to provider for title updates
    this.translationKeysProvider.setTreeView(this.translationKeysView);

    // Set contexts to control visibility
    vscode.commands.executeCommand('setContext', 'poirot.showProjectSelector', true);
    vscode.commands.executeCommand('setContext', 'poirot.showSidebar', true);
  }

  /**
   * Register sidebar-related commands
   */
  private registerSidebarCommands(): void {
    // Register open translation file command
    const openTranslationCommand = vscode.commands.registerCommand(
      'poirot.openTranslationFile',
      async (workspacePath: string, locale: string, key: string) => {
        await this.sidebarService.openTranslationFile(workspacePath, locale, key);
      }
    );

    this.disposables.push(openTranslationCommand);
  }

  /**
   * Register the change locale command
   */
  private registerChangeLocaleCommand(): void {
    const changeLocaleCommand = vscode.commands.registerCommand('poirot.changeLocale', async () => {
      const currentLocale = this.localeService.getCurrentLocale();
      const newLocale = await vscode.window.showInputBox({
        prompt: 'Enter the locale code (e.g., en, es, fr)',
        value: currentLocale,
        placeHolder: 'en',
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
   * Register the extract text command
   */
  private registerExtractTextCommand(): void {
    const extractTextCommand = vscode.commands.registerCommand('poirot.extractText', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active text editor');
        return;
      }

      if (!this.editorService.isSupportedDocument(editor.document)) {
        vscode.window.showErrorMessage(
          'Text extraction is only supported in JavaScript, TypeScript, and Svelte files'
        );
        return;
      }

      const success = await this.extractionService.extractSelectedText(editor);
      if (success) {
        await this.editorService.processDocument(editor.document);
        await this.translationKeysProvider.refresh(editor.document);
        vscode.window.showInformationMessage('Text extracted successfully to locale files');
      }
    });

    this.disposables.push(extractTextCommand);
  }

  /**
   * Register the project selection command
   */
  private registerProjectSelectionCommand(): void {
    const selectProjectCommand = vscode.commands.registerCommand(
      'poirot.selectProject',
      async (projectRelativePath?: string) => {
        try {
          if (
            !vscode.workspace.workspaceFolders ||
            vscode.workspace.workspaceFolders.length === 0
          ) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
          }

          const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
          let selectedPath: string | null;

          if (projectRelativePath) {
            // Specific project was requested (from tree view)
            selectedPath = path.join(workspacePath, projectRelativePath);
          } else {
            // Show project selection dialog
            selectedPath = await this.projectService.showProjectSelection(workspacePath);
          }

          if (selectedPath) {
            // Save the active project setting
            await this.projectService.setActiveProject(workspacePath, selectedPath);

            // Refresh project selector view
            await this.projectSelectorProvider.refresh();

            // Refresh everything with the new project context
            await this.processActiveEditor();

            // Refresh translation keys view
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
              await this.translationKeysProvider.refresh(activeEditor.document);
            }

            // Update translation file watchers for the new project
            await this.setupTranslationFileWatchers();

            vscode.window.showInformationMessage(
              `Active project changed to: ${this.projectService.getProjectName(selectedPath)}`
            );
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error('Error selecting project:', error);
          vscode.window.showErrorMessage(`Failed to select project: ${errorMessage}`);
        }
      }
    );

    this.disposables.push(selectProjectCommand);
  }

  /**
   * Register the translation label click command
   */
  private registerTranslationLabelClickCommand(): void {
    const clickLabelCommand = vscode.commands.registerCommand(
      'poirot.clickTranslationLabel',
      async (translationKey: string, filePath: string) => {
        try {
          // Show the sidebar
          await vscode.commands.executeCommand('workbench.view.extension.poirot');

          // Get the workspace folder to find the current locale
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
          if (!workspaceFolder) {
            vscode.window.showErrorMessage('Cannot determine workspace folder');
            return;
          }

          const workspacePath = workspaceFolder.uri.fsPath;
          const currentLocale = this.localeService.getCurrentLocale();

          // Refresh sidebar with current document to ensure it shows the clicked key
          const activeEditor = vscode.window.activeTextEditor;
          if (activeEditor && activeEditor.document.uri.fsPath === filePath) {
            await this.translationKeysProvider.refresh(activeEditor.document, true);
          }

          // Open the translation file for the current locale and navigate to the key
          await this.sidebarService.openTranslationFile(
            workspacePath,
            currentLocale,
            translationKey
          );

          console.log(`🎯 Clicked translation label: ${translationKey} (locale: ${currentLocale})`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error('Error handling translation label click:', error);
          vscode.window.showErrorMessage(`Failed to navigate to translation: ${errorMessage}`);
        }
      }
    );

    this.disposables.push(clickLabelCommand);
  }

  /**
   * Register right-click inspect translation command
   */
  private registerInspectTranslationAtCursorCommand(): void {
    const inspectTranslationCommand = vscode.commands.registerCommand(
      'poirot.inspectTranslationAtCursor',
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showErrorMessage('No active text editor');
          return;
        }

        if (!this.editorService.isSupportedDocument(editor.document)) {
          vscode.window.showErrorMessage(
            'Translation inspection is only supported in JavaScript, TypeScript, and Svelte files'
          );
          return;
        }

        const translationCall = this.editorService.findTranslationCallAtSelection(
          editor.document,
          editor.selection
        );
        if (!translationCall) {
          vscode.window.showInformationMessage(
            'No translation call found at cursor. Place your cursor on an m.*() call and try again.'
          );
          return;
        }

        await vscode.commands.executeCommand(
          'poirot.clickTranslationLabel',
          translationCall.methodName,
          editor.document.uri.fsPath
        );
      }
    );

    this.disposables.push(inspectTranslationCommand);
  }

  /**
   * Register the CodeLens provider
   */
  private registerCodeLensProvider(): void {
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
   * Register the translation rename provider
   */
  private registerRenameProvider(): void {
    const renameDisposable = vscode.languages.registerRenameProvider(
      [
        { language: 'javascript', scheme: 'file' },
        { language: 'javascriptreact', scheme: 'file' },
        { language: 'typescript', scheme: 'file' },
        { language: 'typescriptreact', scheme: 'file' },
        { language: 'svelte', scheme: 'file' },
      ],
      this.translationRenameProvider
    );

    this.disposables.push(renameDisposable);
  }

  /**
   * Set up file system watchers for translation files
   */
  private async setupTranslationFileWatchers(): Promise<void> {
    try {
      // Clear existing watchers
      this.disposeTranslationFileWatchers();

      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders[0];
      const workspacePath = workspaceFolder.uri.fsPath;

      // Get available locales
      const availableLocales = await this.sidebarService.getAvailableLocales(workspacePath);

      // Create file watchers for each locale
      for (const locale of availableLocales) {
        const translationPath = this.localeService.resolveTranslationPath(workspacePath, locale);
        const relativePath = path.relative(workspacePath, translationPath);

        // Create a file system watcher for this specific translation file
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(workspaceFolder, relativePath),
          false, // Don't ignore creates
          false, // Don't ignore changes
          false // Don't ignore deletes
        );

        // Handle file changes
        watcher.onDidChange(async () => {
          await this.handleTranslationFileChange(locale);
        });

        // Handle file creation (useful for new locale files)
        watcher.onDidCreate(async () => {
          await this.handleTranslationFileChange(locale);
        });

        // Handle file deletion
        watcher.onDidDelete(async () => {
          await this.handleTranslationFileChange(locale);
        });

        this.translationFileWatchers.push(watcher);
        this.disposables.push(watcher);

        console.log(`🔍 Watching translation file: ${relativePath}`);
      }
    } catch (error) {
      console.error('Error setting up translation file watchers:', error);
    }
  }

  /**
   * Handle changes to translation files
   * @param locale The locale of the changed file
   */
  private async handleTranslationFileChange(locale: string): Promise<void> {
    try {
      console.log(`🔄 Translation file changed for locale: ${locale}`);

      const activeEditor = vscode.window.activeTextEditor;
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspacePath) return;

      // Check if sidebar has preserved context (from a previous non-translation file)
      const hasPreservedContext =
        this.translationKeysProvider.currentFilePath &&
        this.translationKeysProvider.translationData.length > 0;

      if (hasPreservedContext) {
        // Refresh the preserved context with updated translation values
        const preservedFilePath = this.translationKeysProvider.currentFilePath;
        if (preservedFilePath) {
          try {
            const preservedDocument = await vscode.workspace.openTextDocument(preservedFilePath);

            // Update editor decorations if the preserved file is currently active
            if (activeEditor && activeEditor.document.uri.fsPath === preservedFilePath) {
              await this.editorService.processDocument(activeEditor.document);
            }

            // Force refresh sidebar with the preserved context to get updated translation values
            await this.translationKeysProvider.refresh(preservedDocument, true);

            console.log(`📋 Updated preserved context for: ${path.basename(preservedFilePath)}`);
          } catch (error) {
            console.error('Error refreshing preserved context:', error);
            // Fallback: just refresh the data structure
            this.translationKeysProvider['_onDidChangeTreeData'].fire();
          }
        }
      } else {
        // No preserved context, refresh current editor if it's supported
        if (activeEditor && this.editorService.isSupportedDocument(activeEditor.document)) {
          await this.editorService.processDocument(activeEditor.document);
          await this.translationKeysProvider.refresh(activeEditor.document);
        }
      }
    } catch (error) {
      console.error('Error handling translation file change:', error);
    }
  }

  /**
   * Dispose of translation file watchers
   */
  private disposeTranslationFileWatchers(): void {
    for (const watcher of this.translationFileWatchers) {
      watcher.dispose();
    }
    this.translationFileWatchers = [];
  }

  /**
   * Refresh sidebar after a document update without replacing active/preserved context.
   * This prevents workspace-wide edits (like rename) from switching the sidebar to a non-active file.
   */
  private async refreshSidebarAfterDocumentUpdate(document: vscode.TextDocument): Promise<void> {
    const activeEditor = vscode.window.activeTextEditor;

    if (activeEditor?.document.uri.toString() === document.uri.toString()) {
      await this.translationKeysProvider.refresh(document);
      return;
    }

    if (this.translationKeysProvider.currentFilePath === document.uri.fsPath) {
      await this.translationKeysProvider.refresh(document, true);
    }
  }

  /**
   * Set up event listeners for document changes and configuration changes
   */
  private setupEventListeners(): void {
    // Listen for document saves
    const saveDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (this.editorService.isSupportedDocument(document)) {
        console.log(`\n💾 Save detected: ${path.basename(document.uri.fsPath)}`);

        // Cancel any pending debounced update for this document since we're doing a full update
        const existingTimeout = this.documentUpdateTimeouts.get(document.uri.toString());
        if (existingTimeout) {
          clearTimeout(existingTimeout);
          this.documentUpdateTimeouts.delete(document.uri.toString());
        }

        await this.editorService.processDocument(document);

        // Refresh sidebar for the saved document
        await this.refreshSidebarAfterDocumentUpdate(document);
      }
    });

    // Listen for active editor changes
    const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor && this.editorService.isSupportedDocument(editor.document)) {
        await this.editorService.processDocument(editor.document);

        // Refresh sidebar for the new active document (don't force if it's a translation file)
        await this.translationKeysProvider.refresh(editor.document);
      } else if (editor && (await this.sidebarService.isTranslationFile(editor.document))) {
        // Don't clear sidebar when switching to translation files - preserve context
        // Call refresh to update UI with preserved data, but don't force update
        await this.translationKeysProvider.refresh(editor.document);
      } else {
        // Clear sidebar if no supported document is active and it's not a translation file
        await this.translationKeysProvider.refresh(null);
      }
    });

    // Listen for document content changes
    const documentChangeDisposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
      const document = event.document;

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

          console.log(
            `\n✏️  Content change detected: ${path.basename(document.uri.fsPath)} (debounced)`
          );
          await this.editorService.processDocument(document);

          // Refresh sidebar for the changed document
          await this.refreshSidebarAfterDocumentUpdate(document);
        } catch (error) {
          console.error('Error processing document content change:', error);
        }
      });
    });

    // Listen for configuration changes
    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('poirot.defaultLocale')) {
        // Refresh current document when locale changes
        await this.processActiveEditor();

        // Refresh sidebar when locale changes
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && this.editorService.isSupportedDocument(activeEditor.document)) {
          await this.translationKeysProvider.refresh(activeEditor.document);
        }
      }

      if (event.affectsConfiguration('poirot.translationCodeLens')) {
        const enabled = vscode.workspace
          .getConfiguration('poirot')
          .get<boolean>('translationCodeLens', true);
        console.log(`🔍 Translation CodeLens ${enabled ? 'enabled' : 'disabled'}`);
        this.editorService.getCodeLensProvider().refresh();
      }

      if (event.affectsConfiguration('poirot.realtimeUpdates')) {
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

      if (event.affectsConfiguration('poirot.updateDelay')) {
        const delay = this.getDebounceDelay();
        console.log(`⏱️  Update delay changed to ${delay}ms`);
      }
    });

    // Listen for workspace folder changes to refresh translation file watchers
    const workspaceFoldersChangeDisposable = vscode.workspace.onDidChangeWorkspaceFolders(
      async () => {
        console.log('📁 Workspace folders changed, refreshing translation file watchers');
        await this.setupTranslationFileWatchers();
      }
    );

    this.disposables.push(
      saveDisposable,
      editorChangeDisposable,
      documentChangeDisposable,
      configChangeDisposable,
      workspaceFoldersChangeDisposable
    );
  }

  /**
   * Process the currently active editor
   */
  private async processActiveEditor(): Promise<void> {
    if (vscode.window.activeTextEditor) {
      const document = vscode.window.activeTextEditor.document;
      if (this.editorService.isSupportedDocument(document)) {
        await this.editorService.processDocument(document);

        // Refresh sidebar for the active document
        await this.translationKeysProvider.refresh(document);
      }
    } else {
      // Clear sidebar if no active editor
      await this.translationKeysProvider.refresh(null);
    }
  }

  /**
   * Deactivate the extension
   */
  deactivate(): void {
    // Clear all pending timeouts
    for (const timeout of this.documentUpdateTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.documentUpdateTimeouts.clear();

    // Dispose of translation file watchers
    this.disposeTranslationFileWatchers();

    // Dispose of other resources
    this.editorService.dispose();
  }
}

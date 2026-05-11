import * as vscode from 'vscode';
import { TranslationService } from '../translation/service';
import { LocaleService } from '../locale/service';
import { ProjectService } from '../project/service';
import { EditorDecorator } from './decorator';
import { TranslationCodeLensProvider } from './codelens';

/**
 * Service for processing VS Code documents and managing translation displays
 */
export class EditorService {
  private translationService: TranslationService;
  private localeService: LocaleService;
  private projectService: ProjectService;
  private editorDecorator: EditorDecorator;
  private codeLensProvider: TranslationCodeLensProvider;

  constructor() {
    this.translationService = new TranslationService();
    this.localeService = new LocaleService();
    this.projectService = new ProjectService();
    this.editorDecorator = new EditorDecorator();
    this.codeLensProvider = new TranslationCodeLensProvider();
  }

  /**
   * Check if document is supported (JavaScript, JavaScript with JSX, TypeScript, TypeScript with JSX, or Svelte)
   * @param document
   * @returns True if the document is supported
   */
  isSupportedDocument(document: vscode.TextDocument): boolean {
    const languageId = document.languageId;
    return ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'svelte'].includes(
      languageId
    );
  }

  /**
   * Process a document to find and display translations
   * @param document The VS Code document to process
   */
  async processDocument(document: vscode.TextDocument): Promise<void> {
    try {
      const editor = vscode.window.visibleTextEditors.find((e) => e.document === document);
      if (!editor) return;

      // Clear previous decorations
      this.editorDecorator.clearDecorations(editor);

      const text = document.getText();
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!workspaceFolder) return;

      const workspacePath = workspaceFolder.uri.fsPath;

      // Find all m.methodName() calls
      const translationCalls = this.translationService.findTranslationCalls(text);
      if (translationCalls.length === 0) {
        // Clear CodeLens when no translation calls are found
        this.codeLensProvider.updateTranslationResults(document, []);
        return;
      }

      // Load translations using the current locale
      const currentLocale = this.localeService.getCurrentLocale();
      const translations = await this.translationService.loadTranslationsForLocale(
        workspacePath,
        currentLocale
      );

      // Process translation calls to get resolved values with warning states
      // Note: We process even if translations is null to show warning labels
      const translationResults = await this.translationService.processTranslationCallsWithWarnings(
        translationCalls,
        translations || {},
        workspacePath,
        currentLocale
      );

      if (translationResults.length === 0) {
        // Clear CodeLens when no translation results are found
        this.codeLensProvider.updateTranslationResults(document, []);
        return;
      }

      // Create and apply decorations for translation values
      const decorations = this.editorDecorator.createDecorations(document, translationResults);
      this.editorDecorator.applyDecorations(editor, decorations);

      // Update CodeLens provider for clickable navigation
      this.codeLensProvider.updateTranslationResults(document, translationResults);

      // Log the results
      const translationValues = translationResults.map((result) => {
        if (result.warningType === 'noLocale') {
          return `${result.methodName}: ❌ no locale defined`;
        } else if (result.warningType === 'missingLocale') {
          return `${result.methodName}: ⚠️ "${result.translationValue}" (missing in ${currentLocale}, found in ${result.foundInLocale})`;
        } else {
          return `${result.methodName}: "${result.translationValue}"`;
        }
      });
      console.log(
        `💡 Updated translation labels and navigation (${currentLocale}): ${translationValues.join(', ')}`
      );
    } catch (error) {
      console.error('Error processing document:', error);
    }
  }

  /**
   * Get the editor decorator instance
   * @returns The editor decorator
   */
  getDecorator(): EditorDecorator {
    return this.editorDecorator;
  }

  /**
   * Get the CodeLens provider instance
   * @returns The CodeLens provider instance
   */
  getCodeLensProvider(): TranslationCodeLensProvider {
    return this.codeLensProvider;
  }

  /**
   * Find translation call at current cursor position or selection
   * @param document The active document
   * @param selection The current selection
   * @returns Translation call metadata or null if no call is found
   */
  findTranslationCallAtSelection(
    document: vscode.TextDocument,
    selection: vscode.Selection
  ): { methodName: string; start: number; end: number } | null {
    const translationCalls = this.translationService.findTranslationCalls(document.getText());

    if (selection.isEmpty) {
      const cursorOffset = document.offsetAt(selection.active);
      const directMatch = translationCalls.find(
        (call) => cursorOffset >= call.start && cursorOffset < call.end
      );
      if (directMatch) {
        return directMatch;
      }

      if (cursorOffset > 0) {
        return (
          translationCalls.find(
            (call) => cursorOffset - 1 >= call.start && cursorOffset - 1 < call.end
          ) || null
        );
      }

      return null;
    }

    const selectionStart = document.offsetAt(selection.start);
    const selectionEnd = document.offsetAt(selection.end);

    return (
      translationCalls.find(
        (call) => selectionStart < call.end && selectionEnd > call.start
      ) || null
    );
  }

  /**
   * Dispose of the service resources
   */
  dispose(): void {
    this.editorDecorator.dispose();
  }
}

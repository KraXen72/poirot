import * as vscode from 'vscode';
import * as path from 'path';
import { humanId } from 'human-id';
import { LocaleService } from '../locale/service';
import { TranslationRepository } from '../translation/repository';
import { formatTranslationCall, setNestedValue } from '../translation/key-utils';

type InterpolationChoice = {
  label: string;
  value: 'template' | 'code';
};

type ExtractionSnapshot = {
  uri: vscode.Uri;
  selection: vscode.Range;
  version: number;
  languageId: string;
  workspacePath: string;
};

type LocaleFileEdit = {
  uri: vscode.Uri;
  range: vscode.Range;
  content: string;
  shouldCreate: boolean;
};

/**
 * Service for extracting strings and adding them to locale files
 */
export class ExtractionService {
  private localeService: LocaleService;
  private translationRepository: TranslationRepository;

  constructor() {
    this.localeService = new LocaleService();
    this.translationRepository = new TranslationRepository();
  }

  /**
   * Strip matching quotes from text if present
   * @param text The text to process
   * @returns Text with matching outer quotes removed
   */
  stripMatchingQuotes(text: string): string {
    if (!text || text.length < 2) {
      return text;
    }

    const firstChar = text[0];
    const lastChar = text[text.length - 1];

    // Check if first and last characters are matching quotes
    if (
      (firstChar === '"' && lastChar === '"') ||
      (firstChar === "'" && lastChar === "'") ||
      (firstChar === '`' && lastChar === '`')
    ) {
      return text.slice(1, -1);
    }

    return text;
  }

  /**
   * Extract selected text and add to locale files
   * @param editor The active text editor
   * @returns True if extraction was successful
   */
  async extractSelectedText(editor: vscode.TextEditor): Promise<boolean> {
    try {
      if (!editor || !editor.selection || editor.selection.isEmpty) {
        vscode.window.showErrorMessage('Please select text to extract');
        return false;
      }

      const selection = new vscode.Range(editor.selection.start, editor.selection.end);
      const rawSelectedText = editor.document.getText(selection).trim();
      if (!rawSelectedText) {
        vscode.window.showErrorMessage('Selected text is empty');
        return false;
      }

      // Strip matching quotes if present
      const selectedText = this.stripMatchingQuotes(rawSelectedText);

      const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found');
        return false;
      }

      const workspacePath = workspaceFolder.uri.fsPath;
      const snapshot: ExtractionSnapshot = {
        uri: editor.document.uri,
        selection,
        version: editor.document.version,
        languageId: editor.document.languageId,
        workspacePath,
      };
      const baseTranslations = await this.loadBaseLocaleTranslations(workspacePath);

      // Check if the exact text already exists in translations (using cleaned text)
      const existingKey = this.searchInTranslations(baseTranslations, selectedText);
      if (existingKey) {
        const interpolationType = await this.getUserInterpolationChoice(
          snapshot.languageId,
          existingKey
        );
        if (!interpolationType) {
          return false;
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.replace(
          snapshot.uri,
          snapshot.selection,
          formatTranslationCall(existingKey, interpolationType)
        );

        return await this.applySnapshotWorkspaceEdit(snapshot, workspaceEdit);
      }

      // Generate new key
      const newKey = this.generateUniqueKeyFromTranslations(baseTranslations);

      // Get interpolation choice from user (showing the real key name)
      const interpolationType = await this.getUserInterpolationChoice(snapshot.languageId, newKey);
      if (!interpolationType) {
        return false; // User cancelled
      }

      const localeFileEdits = await this.prepareLocaleFileEdits(
        workspacePath,
        newKey,
        selectedText
      );
      const workspaceEdit = new vscode.WorkspaceEdit();

      workspaceEdit.replace(
        snapshot.uri,
        snapshot.selection,
        formatTranslationCall(newKey, interpolationType)
      );
      for (const fileEdit of localeFileEdits) {
        if (fileEdit.shouldCreate) {
          workspaceEdit.createFile(fileEdit.uri, { ignoreIfExists: true });
        }
        workspaceEdit.replace(fileEdit.uri, fileEdit.range, fileEdit.content);
      }

      return await this.applySnapshotWorkspaceEdit(snapshot, workspaceEdit);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error during text extraction:', error);
      vscode.window.showErrorMessage(`Failed to extract text: ${errorMessage}`);
      return false;
    }
  }

  private async loadBaseLocaleTranslations(
    workspacePath: string
  ): Promise<Record<string, unknown>> {
    try {
      const inlangSettings = this.localeService.loadInlangSettings(workspacePath);
      const baseLocale = inlangSettings?.baseLocale || 'en';

      const baseTranslationPath = this.localeService.resolveTranslationPath(
        workspacePath,
        baseLocale
      );
      return (
        (await this.translationRepository.loadTranslations(baseTranslationPath, baseLocale)) || {}
      );
    } catch (error) {
      console.error('Error loading base locale translations:', error);
      return {};
    }
  }

  /**
   * Recursively search for text in translations (supports nested objects)
   * @param obj The translations object to search
   * @param text The text to search for
   * @param prefix The key prefix for nested objects
   * @returns The found key or null
   */
  private searchInTranslations(
    obj: Record<string, unknown>,
    text: string,
    prefix = ''
  ): string | null {
    for (const [key, value] of Object.entries(obj)) {
      const currentKey = prefix ? `${prefix}.${key}` : key;

      if (typeof value === 'string' && value === text) {
        return currentKey;
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Recursively search nested objects
        const nestedResult = this.searchInTranslations(
          value as Record<string, unknown>,
          text,
          currentKey
        );
        if (nestedResult) {
          return nestedResult;
        }
      }
    }
    return null;
  }

  private generateUniqueKeyFromTranslations(baseTranslations: Record<string, unknown>): string {
    // Try to generate unique key up to 10 times
    for (let i = 0; i < 10; i++) {
      const key = humanId({
        separator: '_',
        capitalize: false,
        adjectiveCount: 2,
        addAdverb: false,
      });

      if (!baseTranslations[key]) {
        return key;
      }
    }

    // If we couldn't generate a unique key, add a timestamp
    const key = humanId({
      separator: '_',
      capitalize: false,
      adjectiveCount: 2,
      addAdverb: false,
    });
    return `${key}_${Date.now()}`;
  }

  /**
   * Get user's choice for interpolation type
   * @param languageId The language ID of the current file
   * @param keyName The actual key name to show in options (optional)
   * @returns 'template' for {m.key()}, 'code' for m.key(), or null if cancelled
   */
  async getUserInterpolationChoice(
    languageId: string,
    keyName = 'key'
  ): Promise<'template' | 'code' | null> {
    const isSvelteTemplate = languageId === 'svelte';

    const options: InterpolationChoice[] = [
      {
        label: isSvelteTemplate
          ? `{m.${keyName}()} - For Svelte template (recommended)`
          : `m.${keyName}() - For JavaScript/TypeScript code (recommended)`,
        value: isSvelteTemplate ? 'template' : 'code',
      },
      {
        label: isSvelteTemplate
          ? `m.${keyName}() - For JavaScript/TypeScript code`
          : `{m.${keyName}()} - For Svelte template`,
        value: isSvelteTemplate ? 'code' : 'template',
      },
    ];

    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: 'Choose interpolation format for the extracted text',
    });

    return selected ? selected.value : null;
  }

  private async prepareLocaleFileEdits(
    workspacePath: string,
    key: string,
    value: string
  ): Promise<LocaleFileEdit[]> {
    const inlangSettings = this.localeService.loadInlangSettings(workspacePath);
    const baseLocale = inlangSettings?.baseLocale || 'en';
    const locales = new Set(inlangSettings?.locales || []);
    locales.add(baseLocale);

    if (locales.size === 0) {
      locales.add('en');
    }

    return Promise.all(
      [...locales].map((locale) =>
        this.prepareLocaleFileEdit(workspacePath, locale, key, locale === baseLocale ? value : '')
      )
    );
  }

  private async prepareLocaleFileEdit(
    workspacePath: string,
    locale: string,
    key: string,
    value: string
  ): Promise<LocaleFileEdit> {
    const translationPath = this.localeService.resolveTranslationPath(workspacePath, locale);
    const translationUri = vscode.Uri.file(translationPath);
    const fileExists = this.translationRepository.translationFileExists(translationPath);

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(translationPath)));

    let translations: Record<string, unknown> = {};
    let range: vscode.Range;

    if (fileExists) {
      const document = await vscode.workspace.openTextDocument(translationUri);
      try {
        translations = JSON.parse(document.getText()) as Record<string, unknown>;
      } catch {
        throw new Error(
          `Cannot update locale "${locale}" because its translation file has invalid JSON.`
        );
      }

      range = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      );
    } else {
      range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    }

    setNestedValue(translations, key, value);
    return {
      uri: translationUri,
      range,
      content: `${JSON.stringify(translations, null, 2)}\n`,
      shouldCreate: !fileExists,
    };
  }

  private async applySnapshotWorkspaceEdit(
    snapshot: ExtractionSnapshot,
    workspaceEdit: vscode.WorkspaceEdit
  ): Promise<boolean> {
    try {
      const currentDocument = await vscode.workspace.openTextDocument(snapshot.uri);
      if (currentDocument.version !== snapshot.version) {
        vscode.window.showWarningMessage(
          'Extraction was cancelled because the selection changed before edits were applied.'
        );
        return false;
      }

      const applied = await vscode.workspace.applyEdit(workspaceEdit);
      if (!applied) {
        vscode.window.showErrorMessage('Failed to apply extraction edits.');
        return false;
      }
      return true;
    } catch (error) {
      console.error('Error applying extraction edits:', error);
      return false;
    }
  }
}

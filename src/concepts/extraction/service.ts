import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { humanId } from 'human-id';
import { LocaleService } from '../locale/service';
import { TranslationRepository } from '../translation/repository';
import { ProjectService } from '../project/service';
import { formatTranslationCall, setNestedValue } from '../translation/key-utils';

type InterpolationChoice = {
  label: string;
  value: 'template' | 'code';
};

/**
 * Service for extracting strings and adding them to locale files
 */
export class ExtractionService {
  private localeService: LocaleService;
  private translationRepository: TranslationRepository;
  private projectService: ProjectService;

  constructor() {
    this.localeService = new LocaleService();
    this.translationRepository = new TranslationRepository();
    this.projectService = new ProjectService();
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

      const rawSelectedText = editor.document.getText(editor.selection).trim();
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

      // Check if the exact text already exists in translations (using cleaned text)
      const existingKey = await this.findExistingTranslation(workspacePath, selectedText);
      if (existingKey) {
        // Auto-interpolate with existing key without asking
        return await this.replaceTextWithKey(editor, existingKey);
      }

      // Generate new key
      const newKey = await this.generateUniqueKey(workspacePath);
      if (!newKey) {
        vscode.window.showErrorMessage('Failed to generate unique key');
        return false;
      }

      // Get interpolation choice from user (showing the real key name)
      const interpolationType = await this.getUserInterpolationChoice(
        editor.document.languageId,
        newKey
      );
      if (!interpolationType) {
        return false; // User cancelled
      }

      // Add to locale files (using cleaned text)
      const success = await this.addToLocaleFiles(workspacePath, newKey, selectedText);
      if (!success) {
        vscode.window.showErrorMessage('Failed to update locale files');
        return false;
      }

      // Replace selected text with key call
      const keyCall = formatTranslationCall(newKey, interpolationType);
      return await this.replaceSelectedText(editor, keyCall);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error during text extraction:', error);
      vscode.window.showErrorMessage(`Failed to extract text: ${errorMessage}`);
      return false;
    }
  }

  /**
   * Find if the exact text already exists in any translation (supports nested keys)
   * @param workspacePath The workspace root path
   * @param text The text to search for
   * @returns The existing key or null if not found
   */
  async findExistingTranslation(workspacePath: string, text: string): Promise<string | null> {
    try {
      const inlangSettings = this.localeService.loadInlangSettings(workspacePath);
      const baseLocale = inlangSettings?.baseLocale || 'en';

      // Check in base locale first
      const baseTranslationPath = this.localeService.resolveTranslationPath(
        workspacePath,
        baseLocale
      );
      const baseTranslations = await this.translationRepository.loadTranslations(
        baseTranslationPath,
        baseLocale
      );

      if (baseTranslations) {
        const foundKey = this.searchInTranslations(baseTranslations, text);
        if (foundKey) {
          return foundKey;
        }
      }

      return null;
    } catch (error) {
      console.error('Error finding existing translation:', error);
      return null;
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

  /**
   * Generate a unique human-readable key
   * @param workspacePath The workspace root path
   * @returns The generated unique key or null if failed
   */
  async generateUniqueKey(workspacePath: string): Promise<string | null> {
    try {
      const inlangSettings = this.localeService.loadInlangSettings(workspacePath);
      const baseLocale = inlangSettings?.baseLocale || 'en';
      const baseTranslationPath = this.localeService.resolveTranslationPath(
        workspacePath,
        baseLocale
      );
      const baseTranslations =
        (await this.translationRepository.loadTranslations(baseTranslationPath, baseLocale)) || {};

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
    } catch (error) {
      console.error('Error generating unique key:', error);
      return null;
    }
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

  /**
   * Add the new key-value pair to all locale files
   * @param workspacePath The workspace root path
   * @param key The translation key
   * @param value The translation value
   * @returns True if successful
   */
  async addToLocaleFiles(workspacePath: string, key: string, value: string): Promise<boolean> {
    try {
      const inlangSettings = this.localeService.loadInlangSettings(workspacePath);
      const baseLocale = inlangSettings?.baseLocale || 'en';
      const locales = new Set(inlangSettings?.locales || []);
      locales.add(baseLocale);

      if (locales.size === 0) {
        locales.add('en');
      }

      await Promise.all(
        [...locales].map((locale) =>
          this.updateLocaleFile(workspacePath, locale, key, locale === baseLocale ? value : '')
        )
      );

      return true;
    } catch (error) {
      console.error('Error adding to locale files:', error);
      return false;
    }
  }

  /**
   * Update a specific locale file with new key-value pair (supports nested keys)
   * @param workspacePath The workspace root path
   * @param locale The locale to update
   * @param key The translation key (can be nested like "login.inputs.email")
   * @param value The translation value
   */
  async updateLocaleFile(
    workspacePath: string,
    locale: string,
    key: string,
    value: string
  ): Promise<void> {
    try {
      const translationPath = this.localeService.resolveTranslationPath(workspacePath, locale);

      // Load existing translations or create empty object
      let translations: Record<string, unknown> = {};
      if (fs.existsSync(translationPath)) {
        const content = fs.readFileSync(translationPath, 'utf8');
        translations = JSON.parse(content);
      } else {
        // Ensure directory exists
        const dir = path.dirname(translationPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      // Set the nested or flat key-value pair
      setNestedValue(translations, key, value);

      // Write back to file maintaining original key order
      fs.writeFileSync(translationPath, JSON.stringify(translations, null, 2) + '\n', 'utf8');

      console.log(`✅ Updated ${locale} locale file: ${key} = "${value}"`);
    } catch (error) {
      console.error(`Error updating locale file for ${locale}:`, error);
      throw error;
    }
  }

  /**
   * Replace selected text with the key call
   * @param editor The text editor
   * @param replacement The replacement text
   * @returns True if successful
   */
  async replaceSelectedText(editor: vscode.TextEditor, replacement: string): Promise<boolean> {
    try {
      await editor.edit((editBuilder) => {
        editBuilder.replace(editor.selection, replacement);
      });

      // Focus back on the editor
      await vscode.window.showTextDocument(editor.document, editor.viewColumn);

      return true;
    } catch (error) {
      console.error('Error replacing selected text:', error);
      return false;
    }
  }

  /**
   * Replace text with existing key
   * @param editor The text editor
   * @param existingKey The existing translation key
   * @returns True if successful
   */
  async replaceTextWithKey(editor: vscode.TextEditor, existingKey: string): Promise<boolean> {
    const interpolationType = await this.getUserInterpolationChoice(
      editor.document.languageId,
      existingKey
    );
    if (!interpolationType) {
      return false;
    }

    const keyCall = formatTranslationCall(existingKey, interpolationType);
    return await this.replaceSelectedText(editor, keyCall);
  }
}

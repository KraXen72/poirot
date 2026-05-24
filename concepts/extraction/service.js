const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { humanId } = require('human-id');
const { LocaleService } = require('../locale/service');
const { TranslationService } = require('../translation/service');
const { deepClone, setNestedValue, stringifyJsonLike } = require('../utils/json-utils');
const { formatKeyCall } = require('../utils/key-format');
const { stageOrWriteDocumentRange } = require('../utils/text-edits');

/**
 * Service for extracting strings and adding them to locale files
 */
class ExtractionService {
    constructor(localeService = new LocaleService(), translationService = new TranslationService()) {
        this.localeService = localeService;
        this.translationService = translationService;
    }

    /**
     * Strip matching quotes from text if present
     * @param {string} text The text to process
     * @returns {string} Text with matching outer quotes removed
     */
    stripMatchingQuotes(text) {
        if (!text || text.length < 2) {
            return text;
        }

        const firstChar = text[0];
        const lastChar = text[text.length - 1];
        
        // Check if first and last characters are matching quotes
        if ((firstChar === '"' && lastChar === '"') ||
            (firstChar === "'" && lastChar === "'") ||
            (firstChar === '`' && lastChar === '`')) {
            return text.slice(1, -1);
        }

        return text;
    }

    /**
     * Extract selected text and add to locale files
     * @param {vscode.TextEditor} editor The active text editor
     * @returns {Promise<boolean>} True if extraction was successful
     */
    async extractSelectedText(editor) {
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

            return await this._extractAndReplace({
                document: editor.document,
                selection: editor.selection,
                value: selectedText,
                languageId: editor.document.languageId,
                workspacePath: workspaceFolder.uri.fsPath,
            });
        } catch (error) {
            console.error('Error during text extraction', error);
            vscode.window.showErrorMessage(`Failed to extract text: ${error.message}`);
            return false;
        }
    }

    /**
     * If newValue is not present in locale, then add new binding and replace selection with new key, else replace current key with existing key
     * @param {vscode.TextEditor} editor The active text editor
     * @param {vscode.TextEditor['document']} document the active text editor's document
     * @param {vscode.TextEditor['selection']} selection the active text editor's selection
     * @param {string} newValue Text to be added as binding
     * @returns {Promise<boolean>} True if creation was successful
     */
    async createNewBinding(editor, document, selection, newValue) {
        try {
            if (!editor) {
                vscode.window.showErrorMessage('No active text editor');
                return false;
            }

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder found');
                return false;
            }

            return await this._extractAndReplace({
                document,
                selection,
                value: newValue,
                languageId: document.languageId,
                workspacePath: workspaceFolder.uri.fsPath,
                forcedInterpolationType: 'code',
            });
        } catch (error) {
            console.error('Error during creation of new binding:', error);
            vscode.window.showErrorMessage(`Failed to create new binding: ${error.message}`);
            return false;
        }
    }
    /**
     * Extract text & replace it with the i18n id
     * @param {{ 
     *  document: vscode.TextEditor['document'],
     *  selection: vscode.TextEditor['selection'],
     *  value: string,
     *  languageId: string,
     *  workspacePath: string,
     *  forcedInterpolationType?: 'code' | 'template' | (string & {}) | null 
     * }} paramsObj
     */
    async _extractAndReplace({ document, selection, value, languageId, workspacePath, forcedInterpolationType = null }) {
        return await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: 'ElementaryWatson: Extracting...',
                cancellable: false,
            },
            async (progress) => {
                const capturedVersion = document.version;

                progress.report({ message: 'Checking for existing translations...' });

                const inlangSettings = await this.localeService.loadInlangSettingsAsync(workspacePath);
                const existingKey = await this.findExistingTranslation(workspacePath, value, inlangSettings);

                if (existingKey) {
                    const interpolationType = forcedInterpolationType || await this.getUserInterpolationChoice(languageId, existingKey);
                    if (!interpolationType) {
                        return false;
                    }

                    return await this.replaceSelectedText(document, selection, formatKeyCall(existingKey, interpolationType));
                }

                progress.report({ message: 'Generating key...' });
                const baseLocale = inlangSettings?.baseLocale || 'en';
                const baseTranslationPath = await this.localeService.resolveTranslationPathAsync(workspacePath, baseLocale);
                const baseTranslations = await this.loadTranslations(baseTranslationPath);
                const newKey = await this.generateUniqueKey(baseTranslations || {});
                if (!newKey) {
                    vscode.window.showErrorMessage('Failed to generate unique key');
                    return false;
                }

                const interpolationType = forcedInterpolationType || await this.getUserInterpolationChoice(languageId, newKey);
                if (!interpolationType) {
                    return false;
                }

                progress.report({ message: 'Writing locale files...' });
                await this.addToLocaleFiles(workspacePath, newKey, value, inlangSettings);

                // Abort if the document was externally modified during async work
                if (document.version !== capturedVersion) {
                    vscode.window.showWarningMessage(
                        'ElementaryWatson: Document was edited during extraction. Locale files were written — please replace the selected text manually with: ' +
                        formatKeyCall(newKey, interpolationType)
                    );
                    return false;
                }

                progress.report({ message: 'Updating editor...' });
                return await this.replaceSelectedText(document, selection, formatKeyCall(newKey, interpolationType));
            }
        );
    }

    async findExistingTranslation(workspacePath, text, inlangSettings) {
        try {
            const baseLocale = inlangSettings?.baseLocale || 'en';
            // Check in base locale first
            const baseTranslationPath = await this.localeService.resolveTranslationPathAsync(workspacePath, baseLocale);
            const baseTranslations = await this.loadTranslations(baseTranslationPath);
            if (baseTranslations) {
                return this.searchInTranslations(baseTranslations, text);
            }

            return null;
        } catch (error) {
            console.error('Error finding existing translation:', error);
            return null;
        }
    }

    /**
     * Recursively search for text in translations (supports nested objects)
     * @param {Object} obj The translations object to search
     * @param {string} text The text to search for
     * @param {string} prefix The key prefix for nested objects
     * @returns {string|null} The found key or null
     */
    searchInTranslations(obj, text, prefix = '') {
        for (const [key, value] of Object.entries(obj)) {
            const currentKey = prefix ? `${prefix}.${key}` : key;

            if (typeof value === 'string' && value === text) {
                return currentKey;
            }

            if (value && typeof value === 'object' && !Array.isArray(value)) {
                const nestedResult = this.searchInTranslations(value, text, currentKey);
                if (nestedResult) {
                    return nestedResult;
                }
            }
        }

        return null;
    }

    /**
     * Generate a unique human-readable key
     * @param {Record<string, string>} existingTranslations existing translations
     */
    async generateUniqueKey(existingTranslations) {
        // Try to generate unique key up to 10 times
        for (let i = 0; i < 10; i++) {
            const key = humanId({
                separator: '_',
                capitalize: false,
                adjectiveCount: 2,
                addAdverb: false,
            });

            if (!existingTranslations[key]) {
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
     * @param {string} languageId The language ID of the current file
     * @param {string} [keyName] The actual key name to show in options (optional)
     * @returns {Promise<string|null>} 'template' for {m.key()}, 'code' for m.key(), or null if cancelled
     */
    async getUserInterpolationChoice(languageId, keyName = 'key') {
        const isSvelteTemplate = languageId === 'svelte';
        
        const options = [
            {
                label: isSvelteTemplate ? `{m.${keyName}()} - For Svelte template (recommended)` : `m.${keyName}() - For JavaScript/TypeScript code (recommended)`,
                value: isSvelteTemplate ? 'template' : 'code'
            },
            {
                label: isSvelteTemplate ? `m.${keyName}() - For JavaScript/TypeScript code` : `{m.${keyName}()} - For Svelte template`,
                value: isSvelteTemplate ? 'code' : 'template'
            }
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: 'Choose interpolation format for the extracted text',
        });

        return selected ? selected.value : null;
    }

    /**
     * Add the new key-value pair to all locale files
     * @param {string} workspacePath The workspace root path
     * @param {string} key The translation key
     * @param {string} value The translation value
     * @param {{ locales: string[], baseLocale: string, [index: string]: unknown }} inlangSettings inlang settings
     */
    async addToLocaleFiles(workspacePath, key, value, inlangSettings) {
        const availableLocales = inlangSettings?.locales || ['en'];
        const baseLocale = inlangSettings?.baseLocale || 'en';

        await Promise.all(availableLocales.map(async (locale) => {
            const translationValue = locale === baseLocale ? value : '';
            await this.updateLocaleFile(workspacePath, locale, key, translationValue);
        }));
    }

    /**
     * Update a specific locale file with new key-value pair (supports nested keys)
     * @param {string} workspacePath The workspace root path
     * @param {string} locale The locale to update
     * @param {string} key The translation key (can be nested like "login.inputs.email")
     * @param {string} value The translation value
     * @returns {Promise<void>}
     */
     async updateLocaleFile(workspacePath, locale, key, value) {
        const translationPath = await this.localeService.resolveTranslationPathAsync(workspacePath, locale);
        const dir = path.dirname(translationPath);
        await fs.mkdir(dir, { recursive: true });

        let raw = '{}';
        let translations = {};
        try {
            raw = await fs.readFile(translationPath, 'utf8');
            translations = JSON.parse(raw);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }

        const updated = setNestedValue(deepClone(translations), key.split('.'), value);
        const output = stringifyJsonLike(raw, updated);
        await fs.writeFile(translationPath, output, 'utf8');
    }

    /**
     * Replace selected text with the key call
     * @param {vscode.TextEditor['document']} document The text editor's document
     * @param {vscode.TextEditor['selection']} selection The text editor's selection
     * @param {string} replacement The replacement text
     * @returns {Promise<boolean>} True if successful
     */
    async replaceSelectedText(document, selection, replacement) {
        const edit = new vscode.WorkspaceEdit();
        const mode = await stageOrWriteDocumentRange(edit, document, selection, replacement);
        if (mode === 'fileWrite') {
            return true;
        }

        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
            vscode.window.showErrorMessage('ElementaryWatson: Failed to update editor — please try again.');
        }
        return success;
    }

    async loadTranslations(translationPath) {
        try {
            const fileContent = await fs.readFile(translationPath, 'utf8');
            return JSON.parse(fileContent);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }

            throw error;
        }
    }
}

module.exports = { ExtractionService };

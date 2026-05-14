const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { humanId } = require('human-id');
const { LocaleService } = require('../locale/service');
const { TranslationService } = require('../translation/service');
const { deepClone, setNestedValue, stringifyJsonLike } = require('../utils/json-utils');
const { formatKeyCall } = require('../utils/key-format');

class ExtractionService {
    constructor(localeService = new LocaleService(), translationService = new TranslationService()) {
        this.localeService = localeService;
        this.translationService = translationService;
    }

    stripMatchingQuotes(text) {
        if (!text || text.length < 2) {
            return text;
        }

        const firstChar = text[0];
        const lastChar = text[text.length - 1];
        if ((firstChar === '"' && lastChar === '"') ||
            (firstChar === "'" && lastChar === "'") ||
            (firstChar === '`' && lastChar === '`')) {
            return text.slice(1, -1);
        }

        return text;
    }

    async extractSelectedText(editor, document, selection) {
        try {
            if (!editor || !selection || selection.isEmpty) {
                vscode.window.showErrorMessage('Please select text to extract');
                return false;
            }

            const rawSelectedText = document.getText(selection).trim();
            if (!rawSelectedText) {
                vscode.window.showErrorMessage('Selected text is empty');
                return false;
            }

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder found');
                return false;
            }

            const selectedText = this.stripMatchingQuotes(rawSelectedText);
            return await this._extractAndReplace({
                document,
                selection,
                value: selectedText,
                languageId: document.languageId,
                workspacePath: workspaceFolder.uri.fsPath,
            });
        } catch (error) {
            console.error('Error during text extraction', error);
            vscode.window.showErrorMessage(`Failed to extract text: ${error.message}`);
            return false;
        }
    }

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

    async generateUniqueKey(existingTranslations) {
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

        const key = humanId({
            separator: '_',
            capitalize: false,
            adjectiveCount: 2,
            addAdverb: false,
        });
        return `${key}_${Date.now()}`;
    }

    async getUserInterpolationChoice(languageId, keyName = 'key') {
        const isSvelteTemplate = languageId === 'svelte';
        const options = [
            {
                label: isSvelteTemplate ? `{m.${keyName}()} - For Svelte template (recommended)` : `m.${keyName}() - For JavaScript/TypeScript code (recommended)`,
                value: isSvelteTemplate ? 'template' : 'code',
            },
            {
                label: isSvelteTemplate ? `m.${keyName}() - For JavaScript/TypeScript code` : `{m.${keyName}()} - For Svelte template`,
                value: isSvelteTemplate ? 'code' : 'template',
            },
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: 'Choose interpolation format for the extracted text',
        });

        return selected ? selected.value : null;
    }

    async addToLocaleFiles(workspacePath, key, value, inlangSettings) {
        const availableLocales = inlangSettings?.locales || ['en'];
        const baseLocale = inlangSettings?.baseLocale || 'en';

        await Promise.all(availableLocales.map(async (locale) => {
            const translationValue = locale === baseLocale ? value : '';
            await this.updateLocaleFile(workspacePath, locale, key, translationValue);
        }));
    }

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

    async replaceSelectedText(document, selection, replacement) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, selection, replacement);
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

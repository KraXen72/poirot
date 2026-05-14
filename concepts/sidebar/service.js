const vscode = require('vscode');
const fsPromises = require('fs/promises');
const path = require('path');
const { findKeyLine } = require('../utils/json-utils');

class SidebarService {
    constructor(translationService, localeService) {
        this.translationService = translationService;
        this.localeService = localeService;
    }

    /**
     * Get all translation data for the current document
     * @param {vscode.TextDocument} document The current document
     * @returns {Promise<Array>} Array of translation key objects with locale data
     */
    async getTranslationData(document) {
        try {
            if (!document) return [];

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (!workspaceFolder) return [];

            const workspacePath = workspaceFolder.uri.fsPath;
            const text = document.getText();

            const translationCalls = this.translationService.findTranslationCalls(text);
            if (translationCalls.length === 0) return [];

            const availableLocales = await this.getAvailableLocales(workspacePath);
            
            const translationData = [];

            for (const call of translationCalls) {
                const keyData = {
                    key: call.methodName,
                    locales: []
                };

                for (const locale of availableLocales) {
                    const translations = await this.translationService.loadTranslationsForLocale(workspacePath, locale);
                    const translationValue = translations ? this.translationService.getTranslation(translations, call.methodName) : null;
                    
                    if (translationValue !== null) {
                        keyData.locales.push({
                            locale,
                            value: translationValue,
                            workspacePath
                        });
                    }
                }

                if (keyData.locales.length > 0) {
                    translationData.push(keyData);
                }
            }

            return translationData;

        } catch (error) {
            console.error('Error getting translation data for sidebar:', error);
            return [];
        }
    }

    /**
     * Get available locales from inlang settings or fallback
     * @param {string} workspacePath The workspace root path
     * @returns {Promise<Array<string>>} Array of available locale codes
     */
    async getAvailableLocales(workspacePath) {
        return this.localeService.getAvailableLocales(workspacePath);
    }

    /**
     * Open a translation file and navigate to a specific key
     * @param {string} workspacePath The workspace root path
     * @param {string} locale The locale to open
     * @param {string} key The translation key to navigate to
     * @returns {Promise<void>}
     */
    async openTranslationFile(workspacePath, locale, key) {
        try {
            const translationPath = await this.localeService.resolveTranslationPathAsync(workspacePath, locale);
            
            try {
                await fsPromises.access(translationPath);
            } catch (err) {
                const msg = err.code === 'ENOENT'
                    ? `Translation file not found: ${translationPath}`
                    : `Cannot access translation file: ${translationPath} (${err.message})`;
                vscode.window.showErrorMessage(msg);
                return;
            }

            const document = await vscode.workspace.openTextDocument(translationPath);
            const editor = await vscode.window.showTextDocument(document);

            await this.navigateToKey(editor, key);

        } catch (error) {
            console.error('Error opening translation file:', error);
            vscode.window.showErrorMessage(`Failed to open translation file: ${error.message}`);
        }
    }

    /**
     * Navigate to a specific key in the translation file and highlight its value (supports nested keys)
     * @param {vscode.TextEditor} editor The text editor
     * @param {string} key The key to find (can be nested like "login.inputs.email")
     * @returns {Promise<void>}
     */
    async navigateToKey(editor, key) {
        try {
            const document = editor.document;

            let translations;
            try {
                translations = JSON.parse(document.getText());
            } catch {
                vscode.window.showWarningMessage('Translation file contains invalid JSON');
                return;
            }

            const translationValue = this.translationService.getTranslation(translations, key);
            if (translationValue == null) {
                vscode.window.showWarningMessage(`Key "${key}" not found in translation file`);
                return;
            }

            const searchValue = translationValue.endsWith('*') ?
                translationValue.slice(0, -1) : translationValue;

            if (await this.navigateToValue(editor, searchValue)) {
                console.log(`🎯 Navigated to key "${key}" (value: "${searchValue}") in ${document.fileName}`);
                return;
            }

            if (await this.navigateToKeyName(editor, key)) {
                console.log(`🎯 Navigated to key "${key}" (key location) in ${document.fileName}`);
                return;
            }

            vscode.window.showWarningMessage(`Key "${key}" not found in translation file`);

        } catch (error) {
            console.error('Error navigating to key:', error);
            vscode.window.showErrorMessage(`Failed to navigate to key: ${error.message}`);
        }
    }

    /**
     * Navigate to a translation value in the file
     * @param {vscode.TextEditor} editor The text editor
     * @param {string} value The value to find
     * @returns {Promise<boolean>} True if navigation was successful
     */
    async navigateToValue(editor, value) {
        try {
            if (value === '') return false;

            const document = editor.document;
            const text = document.getText();
            
            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const valueRegex = new RegExp(`"${escaped}"`, 'g');
            const match = valueRegex.exec(text);
            
            if (match) {
                const valueStart = match.index + 1; // Skip opening quote
                const valueEnd = valueStart + value.length;
                
                const startPos = document.positionAt(valueStart);
                const endPos = document.positionAt(valueEnd);
                
                const selection = new vscode.Selection(startPos, endPos);
                editor.selection = selection;
                editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
                
                return true;
            }
            
            return false;
        } catch (error) {
            console.error('Error navigating to value:', error);
            return false;
        }
    }

    /**
     * Navigate to a translation key in the file (supports nested keys)
     * @param {vscode.TextEditor} editor The text editor
     * @param {string} key The key to find (can be nested like "login.inputs.email")
     * @returns {Promise<boolean>} True if navigation was successful
     */
    async navigateToKeyName(editor, key) {
        try {
            const document = editor.document;
            const text = document.getText();

            const lineNumber = findKeyLine(text, key);
            if (lineNumber !== null) {
                const line = document.lineAt(lineNumber).text;
                const leafKey = key.split('.').pop();
                const escaped = leafKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const match = new RegExp(`"${escaped}"\\s*:`, 'g').exec(line);
                if (match) {
                    const startPos = new vscode.Position(lineNumber, match.index + 1);
                    const endPos = new vscode.Position(lineNumber, match.index + 1 + leafKey.length);
                    const selection = new vscode.Selection(startPos, endPos);
                    editor.selection = selection;
                    editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
                    return true;
                }
            }
            
            return false;
        } catch (error) {
            console.error('Error navigating to key name:', error);
            return false;
        }
    }

    /**
     * Check if a document is a translation file
     * @param {vscode.TextDocument} document The document to check
     * @returns {Promise<boolean>} True if this is a translation file
     */
    async isTranslationFile(document) {
        try {
            if (!document) {
                return false;
            }
            
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (!workspaceFolder) {
                return false;
            }

            const workspacePath = workspaceFolder.uri.fsPath;
            const filePath = document.uri.fsPath;
            
            const pathPattern = await this.localeService.getTranslationPathPatternAsync(workspacePath);
            const relativePath = path.relative(workspacePath, filePath);
            
            const normalizedRelativePath = relativePath.replace(/\\/g, '/');
            
            const availableLocales = await this.localeService.getAvailableLocales(workspacePath);
            
            for (const locale of availableLocales) {
                let expectedPath = pathPattern.replace('{locale}', locale);
                
                if (expectedPath.startsWith('./')) {
                    expectedPath = expectedPath.substring(2);
                }
                
                expectedPath = expectedPath.replace(/\\/g, '/');
                
                if (normalizedRelativePath === expectedPath) {
                    return true;
                }
            }
            
            return false;
            
        } catch (error) {
            console.error('Error checking if file is translation file:', error);
            return false;
        }
    }
}

module.exports = { SidebarService };
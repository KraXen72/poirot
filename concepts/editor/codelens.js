const vscode = require('vscode');

/**
 * CodeLens provider for clickable translation labels
 */
class TranslationCodeLensProvider {
    constructor() {
        this._onDidChangeCodeLenses = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
        this.translationResults = [];
        this.document = null;
    }

    /**
     * Update translation results for the current document
     * @param {vscode.TextDocument} document The document
     * @param {Array} translationResults Array of translation results
     */
    updateTranslationResults(document, translationResults) {
        this.document = document;
        this.translationResults = translationResults || [];
        this._onDidChangeCodeLenses.fire();
    }

    /**
     * Refresh CodeLens items.
     */
    refresh() {
        this._onDidChangeCodeLenses.fire();
    }

    /**
     * Check whether CodeLens is enabled.
     * @returns {boolean}
     */
    isCodeLensEnabled() {
        const config = vscode.workspace.getConfiguration('elementaryWatson');
        return config.get('enableCodeLens', true);
    }

    /**
     * Get the translation result at a given position.
     * @param {vscode.TextDocument} document The document
     * @param {vscode.Position} position The cursor position
     * @returns {Object|null}
     */
    getTranslationResultAtPosition(document, position) {
        if (!this.document || document.uri.toString() !== this.document.uri.toString()) {
            return null;
        }

        const offset = document.offsetAt(position);

        for (const result of this.translationResults) {
            if (offset >= result.start && offset <= result.end) {
                return result;
            }
        }

        return null;
    }

    /**
     * Check whether a position is on an i18n call.
     * @param {vscode.TextDocument} document The document
     * @param {vscode.Position} position The cursor position
     * @returns {boolean}
     */
    isPositionOnI18nCall(document, position) {
        return !!this.getTranslationResultAtPosition(document, position);
    }

    /**
     * Provide CodeLens items for translation calls
     * @param {vscode.TextDocument} document The document
     * @returns {Array<vscode.CodeLens>} Array of CodeLens items
     */
    provideCodeLenses(document) {
        if (!this.isCodeLensEnabled()) {
            return [];
        }

        if (!this.document || document.uri.toString() !== this.document.uri.toString()) {
            return [];
        }

        const codeLenses = [];
        
        for (const result of this.translationResults) {
            // Position the CodeLens right after the method call
            const position = document.positionAt(result.end);
            const range = new vscode.Range(position, position);
            
            // InspectTranslation codelens
            const inspectCodeLens = new vscode.CodeLens(range, {
                title: `$(globe)  Inspect Translation`,
                command: 'elementaryWatson.clickTranslationLabel',
                arguments: [result.methodName, document.uri.fsPath]
            });
            
            codeLenses.push(inspectCodeLens);

            // CopyTranslation codelens
            const copyCodeLens = new vscode.CodeLens(range, {
                title: `$(copy)  Copy Translation`,
                command: 'elementaryWatson.copyTranslation',
                arguments: [result.translationValue,
                            document.positionAt(result.start),
                            document.positionAt(result.end)]
            });

            codeLenses.push(copyCodeLens);
        }

        return codeLenses;
    }

    /**
     * Resolve a CodeLens (optional, can be used for performance optimization)
     * @param {vscode.CodeLens} codeLens The CodeLens to resolve
     * @returns {vscode.CodeLens} The resolved CodeLens
     */
    resolveCodeLens(codeLens) {
        return codeLens;
    }
}

module.exports = { TranslationCodeLensProvider }; 

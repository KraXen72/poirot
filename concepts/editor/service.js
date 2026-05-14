const vscode = require('vscode');
const { EditorDecorator } = require('./decorator');
const { TranslationCodeLensProvider } = require('./codelens');

/**
 * Service for processing VS Code documents and managing translation displays
 */
class EditorService {
    constructor(translationService, localeService) {
        this.translationService = translationService;
        this.localeService = localeService;
        this.editorDecorator = new EditorDecorator();
        this.codeLensProvider = new TranslationCodeLensProvider();
    }

    /**
     * Check if document is supported (JavaScript, JavaScript with JSX, TypeScript, TypeScript with JSX, or Svelte)
     * @param {vscode.TextDocument} document 
     * @returns {boolean} True if the document is supported
     */
    isSupportedDocument(document) {
        const languageId = document.languageId;
        return ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'svelte'].includes(languageId);
    }

    /**
     * Process a document to find and display translations
     * @param {vscode.TextDocument} document The VS Code document to process
     * @returns {Promise<void>}
     */
    async processDocument(document) {
        try {
            const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
            if (!editor) return;

            this.editorDecorator.clearDecorations(editor);

            const text = document.getText();
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (!workspaceFolder) return;

            const translationCalls = this.translationService.findTranslationCalls(text);
            if (translationCalls.length === 0) {
                this.codeLensProvider.updateTranslationResults(document, []);
                return;
            }

            const currentLocale = await this.localeService.getCurrentLocale();
            const translations = await this.translationService.loadTranslationsForLocale(
                workspaceFolder.uri.fsPath, 
                currentLocale
            );

            const translationResults = await this.translationService.processTranslationCallsWithWarnings(
                translationCalls, 
                translations || {}, 
                workspaceFolder.uri.fsPath,
                currentLocale
            );
            
            if (translationResults.length === 0) {
                this.codeLensProvider.updateTranslationResults(document, []);
                return;
            }

            const decorations = this.editorDecorator.createDecorations(document, translationResults);
            this.editorDecorator.applyDecorations(editor, decorations);

            this.codeLensProvider.updateTranslationResults(document, translationResults);

            const translationValues = translationResults.map(result => {
                if (result.warningType === 'noLocale') {
                    return `${result.methodName}: ❌ no locale defined`;
                } else if (result.warningType === 'missingLocale') {
                    return `${result.methodName}: ⚠️ "${result.translationValue}" (missing in ${currentLocale}, found in ${result.foundInLocale})`;
                } else {
                    return `${result.methodName}: "${result.translationValue}"`;
                }
            });
            console.log(`💡 Updated translation labels and navigation (${currentLocale}): ${translationValues.join(', ')}`);

        } catch (error) {
            console.error('Error processing document:', error);
        }
    }

    /**
     * Get the editor decorator instance
     * @returns {EditorDecorator} The editor decorator
     */
    getDecorator() {
        return this.editorDecorator;
    }

    /**
     * Get the CodeLens provider instance
     * @returns {TranslationCodeLensProvider} The CodeLens provider instance
     */
    getCodeLensProvider() {
        return this.codeLensProvider;
    }

    /**
     * Dispose of the service resources
     */
    dispose() {
        this.editorDecorator.dispose();
    }
}

module.exports = { EditorService };
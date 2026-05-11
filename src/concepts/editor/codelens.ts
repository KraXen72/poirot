import * as vscode from 'vscode';

type TranslationResult = {
  methodName: string;
  end: number;
};

/**
 * CodeLens provider for clickable translation labels
 */
export class TranslationCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void>;
  public onDidChangeCodeLenses: vscode.Event<void>;
  private translationResults: TranslationResult[];
  private document: vscode.TextDocument | null;

  constructor() {
    this._onDidChangeCodeLenses = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    this.translationResults = [];
    this.document = null;
  }

  /**
   * Update translation results for the current document
   * @param document The document
   * @param translationResults Array of translation results
   */
  updateTranslationResults(
    document: vscode.TextDocument,
    translationResults: TranslationResult[]
  ): void {
    this.document = document;
    this.translationResults = translationResults || [];
    this.refresh();
  }

  /**
   * Refresh CodeLens rendering
   */
  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  /**
   * Check if translation CodeLens is enabled in settings
   * @returns True if enabled
   */
  private isTranslationCodeLensEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('poirot');
    return config.get<boolean>('translationCodeLens', true);
  }

  /**
   * Provide CodeLens items for translation calls
   * @param document The document
   * @returns Array of CodeLens items
   */
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.isTranslationCodeLensEnabled()) {
      return [];
    }

    if (!this.document || document.uri.toString() !== this.document.uri.toString()) {
      return [];
    }

    const codeLenses: vscode.CodeLens[] = [];

    for (const result of this.translationResults) {
      // Position the CodeLens right after the method call
      const position = document.positionAt(result.end);
      const range = new vscode.Range(position, position);

      const codeLens = new vscode.CodeLens(range, {
        title: `$(globe)  Inspect Translation`,
        command: 'poirot.clickTranslationLabel',
        arguments: [result.methodName, document.uri.fsPath],
      });

      codeLenses.push(codeLens);
    }

    return codeLenses;
  }

  /**
   * Resolve a CodeLens (optional, can be used for performance optimization)
   * @param codeLens The CodeLens to resolve
   * @returns The resolved CodeLens
   */
  resolveCodeLens(codeLens: vscode.CodeLens): vscode.CodeLens {
    return codeLens;
  }
}

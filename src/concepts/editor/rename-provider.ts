import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LocaleService } from '../locale/service';
import { ProjectService } from '../project/service';
import { TranslationService } from '../translation/service';
import {
  deleteNestedValue,
  formatTranslationAccessor,
  getNestedValue,
  isValidTranslationKey,
  setNestedValue,
} from '../translation/key-utils';

type TranslationCall = ReturnType<TranslationService['findTranslationCalls']>[number];

const SUPPORTED_CODE_FILES = '**/*.{js,jsx,ts,tsx,svelte}';
const EXCLUDED_PATHS = '**/{node_modules,.git,.vscode-test,out,dist}/**';

/**
 * Rename provider that renames Paraglide translation keys in both code and locale files.
 */
export class TranslationRenameProvider implements vscode.RenameProvider {
  private translationService: TranslationService;
  private localeService: LocaleService;
  private projectService: ProjectService;

  constructor() {
    this.translationService = new TranslationService();
    this.localeService = new LocaleService();
    this.projectService = new ProjectService();
  }

  prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Range | { range: vscode.Range; placeholder: string }> {
    const call = this.findTranslationCallAtPosition(document, position);
    if (!call) {
      return null;
    }

    return {
      range: new vscode.Range(document.positionAt(call.keyStart), document.positionAt(call.keyEnd)),
      placeholder: call.methodName,
    };
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string
  ): Promise<vscode.WorkspaceEdit> {
    const targetCall = this.findTranslationCallAtPosition(document, position);
    if (!targetCall) {
      throw new Error(
        'No translation call found at cursor. Place the cursor inside an m.*() call.'
      );
    }

    const nextKey = newName.trim();
    if (!isValidTranslationKey(nextKey)) {
      throw new Error(
        'Invalid translation key. Use dot notation for nesting and avoid spaces or quote characters.'
      );
    }

    if (nextKey === targetCall.methodName) {
      return new vscode.WorkspaceEdit();
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      throw new Error('No workspace folder found for the current document.');
    }

    const workspacePath = workspaceFolder.uri.fsPath;
    const projectPath = this.projectService.getActiveProjectPath(workspacePath);
    const workspaceEdit = new vscode.WorkspaceEdit();

    const codeUpdated = await this.addCodeEdits(
      workspaceEdit,
      projectPath,
      targetCall.methodName,
      nextKey
    );
    const localeUpdated = await this.addLocaleFileEdits(
      workspaceEdit,
      workspacePath,
      targetCall.methodName,
      nextKey
    );

    if (!codeUpdated && !localeUpdated) {
      throw new Error(
        `Translation key "${targetCall.methodName}" was not found in the active project.`
      );
    }

    return workspaceEdit;
  }

  private findTranslationCallAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): TranslationCall | null {
    const calls = this.translationService.findTranslationCalls(document.getText());
    const cursorOffset = document.offsetAt(position);

    const findByOffset = (offset: number): TranslationCall | null => {
      const keyMatch =
        calls.find((call) => offset >= call.keyStart && offset <= call.keyEnd) ?? null;
      if (keyMatch) {
        return keyMatch;
      }

      return calls.find((call) => offset >= call.start && offset <= call.end) ?? null;
    };

    return findByOffset(cursorOffset) || (cursorOffset > 0 ? findByOffset(cursorOffset - 1) : null);
  }

  private async addCodeEdits(
    workspaceEdit: vscode.WorkspaceEdit,
    projectPath: string,
    currentKey: string,
    nextKey: string
  ): Promise<boolean> {
    const includePattern = new vscode.RelativePattern(projectPath, SUPPORTED_CODE_FILES);
    const files = await vscode.workspace.findFiles(includePattern, EXCLUDED_PATHS);

    let updated = false;
    for (const file of files) {
      const document = await vscode.workspace.openTextDocument(file);
      const translationCalls = this.translationService
        .findTranslationCalls(document.getText())
        .filter((call) => call.methodName === currentKey);

      for (const call of translationCalls) {
        const replacement = this.createCallReplacement(document, call, nextKey);
        const range = new vscode.Range(
          document.positionAt(call.start),
          document.positionAt(call.end)
        );

        workspaceEdit.replace(file, range, replacement);
        updated = true;
      }
    }

    return updated;
  }

  private createCallReplacement(
    document: vscode.TextDocument,
    call: TranslationCall,
    nextKey: string
  ): string {
    const suffixRange = new vscode.Range(
      document.positionAt(call.accessorEnd),
      document.positionAt(call.end)
    );
    const suffix = document.getText(suffixRange);

    return `${formatTranslationAccessor(nextKey)}${suffix}`;
  }

  private async addLocaleFileEdits(
    workspaceEdit: vscode.WorkspaceEdit,
    workspacePath: string,
    currentKey: string,
    nextKey: string
  ): Promise<boolean> {
    const locales = await this.getAvailableLocales(workspacePath);
    let updated = false;

    for (const locale of locales) {
      const translationPath = this.localeService.resolveTranslationPath(workspacePath, locale);
      const translationUri = vscode.Uri.file(translationPath);

      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(translationUri);
      } catch {
        continue;
      }

      let translations: Record<string, unknown>;
      try {
        translations = JSON.parse(document.getText()) as Record<string, unknown>;
      } catch {
        throw new Error(
          `Cannot rename key in locale "${locale}" because the file contains invalid JSON.`
        );
      }

      const currentValue = getNestedValue(translations, currentKey);
      if (currentValue === undefined) {
        continue;
      }

      if (getNestedValue(translations, nextKey) !== undefined) {
        throw new Error(
          `Cannot rename key to "${nextKey}" because it already exists in locale "${locale}".`
        );
      }

      deleteNestedValue(translations, currentKey);
      setNestedValue(translations, nextKey, currentValue);

      const updatedContent = `${JSON.stringify(translations, null, 2)}\n`;
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      );
      workspaceEdit.replace(translationUri, fullRange, updatedContent);
      updated = true;
    }

    return updated;
  }

  private async getAvailableLocales(workspacePath: string): Promise<string[]> {
    const projectPath = this.projectService.getActiveProjectPath(workspacePath);
    const inlangSettings = this.localeService.loadInlangSettings(workspacePath);
    const locales = new Set(inlangSettings?.locales || []);

    if (inlangSettings?.baseLocale) {
      locales.add(inlangSettings.baseLocale);
    }

    if (locales.size > 0) {
      return [...locales];
    }

    const messagesDir = path.join(projectPath, 'messages');
    if (fs.existsSync(messagesDir)) {
      const detectedLocales = fs
        .readdirSync(messagesDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => path.basename(file, '.json'));

      if (detectedLocales.length > 0) {
        return detectedLocales;
      }
    }

    locales.add('en');
    return [...locales];
  }
}

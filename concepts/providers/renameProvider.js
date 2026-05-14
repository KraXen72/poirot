/// <reference types="node" />
const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { getKeyAtPosition, getKeyRangeAtPosition, getLocaleFilePaths, getProjectRoot } = require('../utils/i18n-detection');
const { getNestedValue, stringifyJsonLike, renameJsonKey } = require('../utils/json-utils');

const KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;

/**
 * @typedef {{ methodName: string, params: string, start: number, end: number, keyType: 'flat' | 'nested' }} TranslationCall
 */

class TranslationKeyRenameProvider {
    constructor(translationService, onBeforeRename = null) {
        if (!translationService) {
            throw new Error('TranslationKeyRenameProvider requires translationService');
        }
        this.translationService = translationService;
        this.onBeforeRename = onBeforeRename;
    }

    /**
     * @param {import('vscode').TextDocument} document
     * @param {import('vscode').Position} position
     */
    prepareRename(document, position) {
        const key = getKeyAtPosition(document, position);
        if (key === null) {
            return Promise.reject(new Error('Rename is only available on translation key call sites.'));
        }

        const range = getKeyRangeAtPosition(document, position);
        return { range, placeholder: key };
    }

    /**
     * @param {import('vscode').TextDocument} document
     * @param {import('vscode').Position} position
     * @param {string} newName
     */
    async provideRenameEdits(document, position, newName) {
        if (!KEY_PATTERN.test(newName)) {
            return Promise.reject(new Error(`"${newName}" is not a valid translation key. Use letters, numbers, underscores, and dots only.`));
        }

        const oldKey = getKeyAtPosition(document, position);
        if (oldKey === null) {
            return Promise.reject(new Error('No translation key at cursor.'));
        }

        if (oldKey === newName) {
            return new vscode.WorkspaceEdit();
        }

        const projectRoot = getProjectRoot(document);
        if (projectRoot === null) {
            return Promise.reject(new Error('Could not find inlang project root for this file.'));
        }

        const edit = new vscode.WorkspaceEdit();
        await renameInLocaleFiles(edit, projectRoot, oldKey, newName);
        await renameInSourceFiles(edit, projectRoot, oldKey, newName, this.translationService);
        if (this.onBeforeRename) this.onBeforeRename(500);
        return edit;
    }
}

/**
 * @param {import('vscode').WorkspaceEdit} edit
 * @param {string} projectRoot
 * @param {string} oldKey
 * @param {string} newKey
 * @returns {Promise<void>}
 */
async function renameInLocaleFiles(edit, projectRoot, oldKey, newKey) {
    const localeFiles = await loadLocaleFiles(projectRoot, oldKey, newKey);

    for (const localeFile of localeFiles) {
        if (!localeFile.hasOldKey) {
            continue;
        }

        const updated = renameJsonKey(localeFile.json, oldKey, newKey);
        edit.replace(localeFile.uri, fullDocumentRange(), stringifyJsonLike(localeFile.raw, updated));
    }
}

/**
 * @param {string} projectRoot
 * @param {string} oldKey
 * @param {string} newKey
 * @returns {Promise<Array<{ uri: import('vscode').Uri, raw: string, json: Record<string, unknown>, hasOldKey: boolean, hasNewKey: boolean }>>}
 */
async function loadLocaleFiles(projectRoot, oldKey, newKey) {
    const localePaths = await getLocaleFilePaths(projectRoot);
    const files = [];

    for (const filePath of localePaths) {
        const raw = await readTextFile(filePath);
        if (raw === null) {
            continue;
        }

        const json = parseJson(raw);
        if (json === null) {
            continue;
        }

        files.push({
            uri: vscode.Uri.file(filePath),
            raw,
            json,
            hasOldKey: isKeyPresent(json, oldKey),
            hasNewKey: isKeyPresent(json, newKey),
        });
    }

    for (const file of files) {
        if (file.hasNewKey) {
            return Promise.reject(new Error(`Key "${newKey}" already exists in ${path.basename(file.uri.fsPath)}. Rename aborted.`));
        }
    }

    return files;
}

/**
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
async function readTextFile(filePath) {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch {
        return null;
    }
}

/**
 * @param {string} raw
 * @returns {Record<string, unknown> | null}
 */
function parseJson(raw) {
    try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * @returns {import('vscode').Range}
 */
function fullDocumentRange() {
    return new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    );
}

/**
 * @param {import('vscode').WorkspaceEdit} edit
 * @param {string} projectRoot
 * @param {string} oldKey
 * @param {string} newKey
 * @param {TranslationService} translationService
 * @returns {Promise<void>}
 */
async function renameInSourceFiles(edit, projectRoot, oldKey, newKey, translationService) {
    const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(projectRoot, '**/*.{ts,js,svelte}'),
        new vscode.RelativePattern(projectRoot, '**/{node_modules,.git,paraglide}/**'),
    );

    for (const fileUri of files) {
        const document = await vscode.workspace.openTextDocument(fileUri);
        const text = document.getText();

        for (const call of translationService.findTranslationCalls(text)) {
            if (call.methodName !== oldKey) {
                continue;
            }

            const sourceEdit = buildSourceEdit(document, call, text, newKey);
            edit.replace(document.uri, sourceEdit.range, sourceEdit.replacement);
        }
    }
}

/**
 * @param {import('vscode').TextDocument} document
 * @param {TranslationCall} call
 * @param {string} text
 * @param {string} newKey
 * @returns {{ range: import('vscode').Range, replacement: string }}
 */
function buildSourceEdit(document, call, text, newKey) {
    if (call.keyType === 'flat') {
        return {
            range: newKey.includes('.') ? new vscode.Range(
                document.positionAt(call.start + 1),
                document.positionAt(call.start + 2 + call.methodName.length),
            ) : new vscode.Range(
                document.positionAt(call.start + 2),
                document.positionAt(call.start + 2 + call.methodName.length),
            ),
            replacement: newKey.includes('.') ? `["${newKey}"]` : newKey,
        };
    }

    const matchText = text.slice(call.start, call.end);
    const nestedMatch = /\bm\[(["'`])([^"'`]+)\1\]\s*\(/.exec(matchText);
    if (!nestedMatch) {
        return {
            range: new vscode.Range(document.positionAt(call.start), document.positionAt(call.end)),
            replacement: newKey,
        };
    }

    const keyOffset = matchText.indexOf(nestedMatch[2]);
    const range = new vscode.Range(
        document.positionAt(call.start + keyOffset),
        document.positionAt(call.start + keyOffset + nestedMatch[2].length),
    );
    return { range, replacement: newKey };
}

/**
 * @param {unknown} obj
 * @param {string} keyPath
 * @returns {boolean}
 */
function isKeyPresent(obj, keyPath) {
    return getNestedValue(obj, keyPath.split('.')) !== undefined;
}

module.exports = {
    TranslationKeyRenameProvider,
};

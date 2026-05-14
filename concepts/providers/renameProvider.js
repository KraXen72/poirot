/// <reference types="node" />
const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { TranslationService } = require('../translation/service');
const { getKeyAtPosition, getKeyRangeAtPosition, getLocaleFilePaths, getProjectRoot } = require('../utils/i18n-detection');

const KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;

/**
 * @typedef {{ methodName: string, params: string, start: number, end: number, keyType: 'flat' | 'nested' }} TranslationCall
 */

class TranslationKeyRenameProvider {
    constructor() {
        this.translationService = new TranslationService();
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
    const localePaths = getLocaleFilePaths(projectRoot);
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

/**
 * @param {unknown} obj
 * @param {string[]} segments
 * @returns {unknown}
 */
function getNestedValue(obj, segments) {
    return segments.reduce((current, segment) => {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return undefined;
        }

        return /** @type {Record<string, unknown>} */ (current)[segment];
    }, obj);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} oldKey
 * @param {string} newKey
 * @returns {Record<string, unknown>}
 */
function renameJsonKey(obj, oldKey, newKey) {
    if (oldKey === newKey) {
        return obj;
    }

    const oldSegments = oldKey.split('.');
    const newSegments = newKey.split('.');
    const value = getNestedValue(obj, oldSegments);

    if (value === undefined) {
        return obj;
    }

    if (oldSegments.length === newSegments.length && oldSegments.slice(0, -1).join('.') === newSegments.slice(0, -1).join('.')) {
        return renameWithinSameParent(obj, oldSegments, newSegments);
    }

    const clone = /** @type {Record<string, unknown>} */ (deepClone(obj));
    deleteNestedValue(clone, oldSegments);
    setNestedValue(clone, newSegments, value);
    return clone;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} oldSegments
 * @param {string[]} newSegments
 * @returns {Record<string, unknown>}
 */
function renameWithinSameParent(obj, oldSegments, newSegments) {
    const parentSegments = oldSegments.slice(0, -1);
    const parent = getNestedValue(obj, parentSegments);

    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) {
        const clone = /** @type {Record<string, unknown>} */ (deepClone(obj));
        deleteNestedValue(clone, oldSegments);
        setNestedValue(clone, newSegments, getNestedValue(obj, oldSegments));
        return clone;
    }

    const oldLeaf = oldSegments[oldSegments.length - 1];
    const newLeaf = newSegments[newSegments.length - 1];
    const rebuiltParent = /** @type {Record<string, unknown>} */ ({});

    for (const [key, value] of Object.entries(parent)) {
        rebuiltParent[key === oldLeaf ? newLeaf : key] = value;
    }

    if (parentSegments.length === 0) {
        return rebuiltParent;
    }

    const clone = /** @type {Record<string, unknown>} */ (deepClone(obj));
    setNestedValue(clone, parentSegments, rebuiltParent);
    return clone;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} segments
 * @returns {void}
 */
function deleteNestedValue(obj, segments) {
    if (segments.length === 0) {
        return;
    }

    const parentSegments = segments.slice(0, -1);
    const parent = /** @type {Record<string, unknown> | unknown} */ (parentSegments.length === 0 ? obj : getNestedValue(obj, parentSegments));

    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) {
        return;
    }

    delete /** @type {Record<string, unknown>} */ (parent)[segments[segments.length - 1]];
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} segments
 * @param {unknown} value
 * @returns {unknown}
 */
function setNestedValue(obj, segments, value) {
    if (segments.length === 0) {
        return value;
    }

    let current = /** @type {Record<string, unknown>} */ (obj);

    for (let index = 0; index < segments.length - 1; index++) {
        const segment = segments[index];
        if (current[segment] === undefined || typeof current[segment] !== 'object' || Array.isArray(current[segment])) {
            current[segment] = {};
        }

        current = /** @type {Record<string, unknown>} */ (current[segment]);
    }

    current[segments[segments.length - 1]] = value;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function deepClone(value) {
    return /** @type {Record<string, unknown>} */ (JSON.parse(JSON.stringify(value)));
}

/**
 * @param {string} raw
 * @returns {string | number}
 */
function detectIndent(raw) {
    const match = raw.match(/^[\t ]+/m);
    if (!match) {
        return 2;
    }

    return match[0].startsWith('\t') ? '\t' : match[0].length;
}

/**
 * @param {string} raw
 * @param {Record<string, unknown>} json
 * @returns {string}
 */
function stringifyJsonLike(raw, json) {
    return JSON.stringify(json, null, detectIndent(raw)) + (raw.endsWith('\n') ? '\n' : '');
}

module.exports = {
    TranslationKeyRenameProvider,
};

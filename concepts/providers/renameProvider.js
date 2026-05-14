// @ts-check
/// <reference types="node" />
const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { getKeyAtPosition, getLocaleFilePaths, getProjectRoot } = require('../utils/i18n-detection');
const { getNestedValue, stringifyJsonLike, renameJsonKey } = require('../utils/json-utils');

const KEY_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_.]*$/;

/**
 * Validates `newKey`. Returns an error string if invalid, null if valid.
 * @param {string} newKey
 * @returns {string | null}
 */
function validateRenameKey(newKey) {
    if (!KEY_PATTERN.test(newKey)) {
        return 'Not a valid translation key. Use letters, numbers, underscores, and dots only.';
    }
    return null;
}

/**
 * Builds a WorkspaceEdit that renames `oldKey` → `newKey` across all locale
 * files and source files in the project rooted at the document's workspace.
 *
 * @param {vscode.WorkspaceEdit} edit  Mutated in-place.
 * @param {vscode.TextDocument} document  The source document the cursor is in.
 * @param {string} oldKey
 * @param {string} newKey
 * @param {object} translationService  Must expose `findTranslationCalls(text)`.
 * @returns {Promise<void>}  Rejects with a user-facing Error on any problem.
 */
async function buildRenameEdit(edit, document, oldKey, newKey, translationService) {
    if (oldKey === newKey) return;

    const projectRoot = getProjectRoot(document);
    if (!projectRoot) throw new Error('Could not find inlang project root for this file.');

    await _renameInLocaleFiles(edit, projectRoot, oldKey, newKey);
    await _renameInSourceFiles(edit, projectRoot, oldKey, newKey, translationService);
}

// ── private helpers ──────────────────────────────────────────────────────────

async function _renameInLocaleFiles(edit, projectRoot, oldKey, newKey) {
    const localeFiles = await _loadLocaleFiles(projectRoot, oldKey, newKey);
    for (const lf of localeFiles) {
        if (!lf.hasOldKey) continue;
        const updated = renameJsonKey(lf.json, oldKey, newKey);
        edit.replace(lf.uri, _fullDocumentRange(), stringifyJsonLike(lf.raw, updated));
    }
}

async function _loadLocaleFiles(projectRoot, oldKey, newKey) {
    const localePaths = await getLocaleFilePaths(projectRoot);
    const files = [];
    for (const filePath of localePaths) {
        const raw = await _readText(filePath);
        if (raw == null) continue;
        const json = _parseJson(raw);
        if (json == null) continue;
        files.push({
            uri: vscode.Uri.file(filePath),
            raw,
            json,
            hasOldKey: _isKeyPresent(json, oldKey),
            hasNewKey: _isKeyPresent(json, newKey),
        });
    }
    for (const f of files) {
        if (f.hasNewKey) throw new Error(`Key "${newKey}" already exists in ${path.basename(f.uri.fsPath)}. Rename aborted.`);
    }
    return files;
}

async function _renameInSourceFiles(edit, projectRoot, oldKey, newKey, translationService) {
    const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(projectRoot, '**/*.{ts,js,svelte}'),
        new vscode.RelativePattern(projectRoot, '{node_modules,.git,paraglide}/**'),
    );
    for (const fileUri of files) {
        if (fileUri.fsPath.includes('paraglide') || fileUri.fsPath.includes('node_modules')) continue;
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const text = doc.getText();
        for (const call of translationService.findTranslationCalls(text)) {
            if (call.methodName !== oldKey) continue;
            const src = _buildSourceEdit(doc, call, text, newKey);
            edit.replace(doc.uri, src.range, src.replacement);
        }
    }
}

/**
 * @param {vscode.TextDocument} document
 * @param {{ keyType: string, start: number, end: number, methodName: string }} call
 * @param {string} text
 * @param {string} newKey
 * @returns {{ range: vscode.Range, replacement: string }}
 */
function _buildSourceEdit(document, call, text, newKey) {
    if (call.keyType === 'flat') {
        return {
            range: newKey.includes('.')
                ? new vscode.Range(document.positionAt(call.start + 1), document.positionAt(call.start + 2 + call.methodName.length))
                : new vscode.Range(document.positionAt(call.start + 2), document.positionAt(call.start + 2 + call.methodName.length)),
            replacement: newKey.includes('.') ? `["${newKey}"]` : newKey,
        };
    }
    const matchText = text.slice(call.start, call.end);
    const nestedMatch = /\["([^\]]+)"\]/.exec(matchText);
    if (!nestedMatch) {
        return {
            range: new vscode.Range(document.positionAt(call.start), document.positionAt(call.end)),
            replacement: newKey,
        };
    }
    const keyOffset = matchText.indexOf(nestedMatch[2]);
    return {
        range: new vscode.Range(
            document.positionAt(call.start + keyOffset),
            document.positionAt(call.start + keyOffset + nestedMatch[2].length),
        ),
        replacement: newKey,
    };
}

async function _readText(filePath) {
    try { return await fs.readFile(filePath, 'utf8'); } catch { return null; }
}

function _parseJson(raw) {
    try {
        const v = JSON.parse(raw);
        return typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch { return null; }
}

function _fullDocumentRange() {
    return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
}

function _isKeyPresent(obj, keyPath) {
    return getNestedValue(obj, keyPath.split('.')) !== undefined;
}

module.exports = { buildRenameEdit, validateRenameKey };
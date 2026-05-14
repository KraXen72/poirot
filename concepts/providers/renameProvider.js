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
 * Renames `oldKey` → `newKey` across all locale files and source files by
 * writing directly to disk. The single exception is `activeDocument`: that
 * file's edit is added to `edit` (a WorkspaceEdit) so the open buffer stays
 * consistent and the change is undoable.
 *
 * @param {vscode.WorkspaceEdit} edit         Receives only the active-document edit.
 * @param {vscode.TextDocument}  activeDocument  The document the cursor is in.
 * @param {string} oldKey
 * @param {string} newKey
 * @param {object} translationService         Must expose `findTranslationCalls(text)`.
 * @returns {Promise<void>}  Rejects with a user-facing Error on any problem.
 */
async function buildRenameEdit(edit, activeDocument, oldKey, newKey, translationService) {
    if (oldKey === newKey) return;

    const projectRoot = getProjectRoot(activeDocument);
    if (!projectRoot) throw new Error('Could not find inlang project root for this file.');

    await _renameInLocaleFiles(projectRoot, oldKey, newKey);
    await _renameInSourceFiles(edit, activeDocument, projectRoot, oldKey, newKey, translationService);
}

// ── locale files ─────────────────────────────────────────────────────────────

async function _renameInLocaleFiles(projectRoot, oldKey, newKey) {
    const localeFiles = await _loadLocaleFiles(projectRoot, oldKey, newKey);
    await Promise.all(
        localeFiles
            .filter(lf => lf.hasOldKey)
            .map(lf => {
                const updated = renameJsonKey(lf.json, oldKey, newKey);
                const content = stringifyJsonLike(lf.raw, updated);
                return vscode.workspace.fs.writeFile(lf.uri, Buffer.from(content, 'utf8'));
            })
    );
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
        if (f.hasNewKey) {
            throw new Error(`Key "${newKey}" already exists in ${path.basename(f.uri.fsPath)}. Rename aborted.`);
        }
    }
    return files;
}

// ── source files ──────────────────────────────────────────────────────────────

async function _renameInSourceFiles(edit, activeDocument, projectRoot, oldKey, newKey, translationService) {
    const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(projectRoot, '**/*.{ts,js,svelte}'),
        new vscode.RelativePattern(projectRoot, '{node_modules,.git,paraglide}/**'),
    );

    await Promise.all(files.map(async fileUri => {
        if (fileUri.fsPath.includes('paraglide') || fileUri.fsPath.includes('node_modules')) return;

        const raw = await _readText(fileUri.fsPath);
        if (raw == null) return;

        const calls = translationService.findTranslationCalls(raw).filter(c => c.methodName === oldKey);
        if (calls.length === 0) return;

        const isActiveDoc = fileUri.toString() === activeDocument.uri.toString();

        if (isActiveDoc) {
            // Active document: go through WorkspaceEdit so the open buffer
            // stays in sync and the edit is undoable.
            for (const call of calls) {
                const src = _buildSourceEdit(activeDocument, call, raw, newKey);
                edit.replace(activeDocument.uri, src.range, src.replacement);
            }
        } else {
            // Not open: apply replacements to the raw string and write to disk.
            const newContent = _applyReplacementsToText(raw, calls, newKey);
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(newContent, 'utf8'));
        }
    }));
}

/**
 * Applies all call-site renames to a raw string without touching the editor
 * model. Processes replacements in reverse order so offsets stay valid.
 *
 * @param {string} text
 * @param {Array<{keyType: string, start: number, end: number, methodName: string}>} calls
 * @param {string} newKey
 * @returns {string}
 */
function _applyReplacementsToText(text, calls, newKey) {
    // Sort descending by start offset so each splice doesn't shift later offsets.
    const sorted = calls.slice().sort((a, b) => b.start - a.start);
    let result = text;
    for (const call of sorted) {
        const { charStart, charEnd, replacement } = _buildCharReplacement(result, call, newKey);
        result = result.slice(0, charStart) + replacement + result.slice(charEnd);
    }
    return result;
}

/**
 * Returns the character-offset span and replacement string for a call in raw text.
 *
 * @param {string} text
 * @param {{keyType: string, start: number, end: number, methodName: string}} call
 * @param {string} newKey
 * @returns {{ charStart: number, charEnd: number, replacement: string }}
 */
function _buildCharReplacement(text, call, newKey) {
    if (call.keyType === 'flat') {
        if (newKey.includes('.')) {
            // m.oldKey()  →  m["newKey"]()  : replace from the dot through end of method name
            return {
                charStart: call.start + 1,
                charEnd:   call.start + 2 + call.methodName.length,
                replacement: `["${newKey}"]`,
            };
        } else {
            // m.oldKey()  →  m.newKey()  : replace just the method name portion
            return {
                charStart: call.start + 2,
                charEnd:   call.start + 2 + call.methodName.length,
                replacement: newKey,
            };
        }
    }

    // nested: m["oldKey"]()
    const matchText = text.slice(call.start, call.end);
    const nestedMatch = /\["([^\]]+)"\]/.exec(matchText);
    if (!nestedMatch) {
        return { charStart: call.start, charEnd: call.end, replacement: newKey };
    }
    const keyOffset = matchText.indexOf(nestedMatch[1]);
    return {
        charStart: call.start + keyOffset,
        charEnd:   call.start + keyOffset + nestedMatch[1].length,
        replacement: newKey,
    };
}

/**
 * Builds a WorkspaceEdit range+replacement for the active (open) document.
 * Delegates to the same offset logic as _buildCharReplacement but returns
 * vscode.Range values instead.
 *
 * @param {vscode.TextDocument} document
 * @param {{keyType: string, start: number, end: number, methodName: string}} call
 * @param {string} text
 * @param {string} newKey
 * @returns {{ range: vscode.Range, replacement: string }}
 */
function _buildSourceEdit(document, call, text, newKey) {
    const { charStart, charEnd, replacement } = _buildCharReplacement(text, call, newKey);
    return {
        range: new vscode.Range(document.positionAt(charStart), document.positionAt(charEnd)),
        replacement,
    };
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function _readText(filePath) {
    try { return await fs.readFile(filePath, 'utf8'); } catch { return null; }
}

function _parseJson(raw) {
    try {
        const v = JSON.parse(raw);
        return typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch { return null; }
}

function _isKeyPresent(obj, keyPath) {
    return getNestedValue(obj, keyPath.split('.')) !== undefined;
}

module.exports = { buildRenameEdit, validateRenameKey };
// @ts-check
/// <reference types="node" />
const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { getLocaleFilePaths, getProjectRoot } = require('../utils/i18n-detection');
const { getNestedValue, stringifyJsonLike, renameJsonKey } = require('../utils/json-utils');

const KEY_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_.]*$/;

/**
 * Validates a new translation key against the allowed character pattern.
 *
 * @param {string} newKey - The key string to validate.
 * @returns {string | null} An error message if the key is invalid, or `null` if it is valid.
 */
function validateRenameKey(newKey) {
    if (!KEY_PATTERN.test(newKey)) {
        return 'Not a valid translation key. Use letters, numbers, underscores, and dots only.';
    }
    return null;
}

/**
 * Orchestrates the renaming of a translation key (`oldKey` to `newKey`) across an entire project.
 * It updates all locale files (JSON) and source files (.ts, .js, .svelte). File-system writes
 * are performed directly, except for the currently active document, whose edits are added to
 * the provided `WorkspaceEdit` to keep the editor state consistent and the change undoable.
 *
 * @param {vscode.WorkspaceEdit} edit - The workspace edit object to which the active document's text replacements are added.
 * @param {vscode.TextDocument} activeDocument - The text document that is currently active in the editor.
 * @param {string} oldKey - The original dot-separated translation key to rename.
 * @param {string} newKey - The new dot-separated translation key.
 * @param {object} translationService - A service object that must expose a `findTranslationCalls(text: string)` method.
 * @param {object} localeService - A service object that must expose a `getLocaleFilePaths(projectRoot: string)` method.
 * @returns {Promise<void>} A promise that resolves when all replacements are complete.
 * @throws {Error} Throws a user-facing error if the project root cannot be found or if the operation fails.
 */
async function buildRenameEdit(edit, activeDocument, oldKey, newKey, translationService, localeService) {
    if (oldKey === newKey) return;

    const projectRoot = getProjectRoot(activeDocument);
    if (!projectRoot) throw new Error('Could not find inlang project root for this file.');

    await _renameInLocaleFiles(projectRoot, oldKey, newKey, localeService);
    await _renameInSourceFiles(edit, activeDocument, projectRoot, oldKey, newKey, translationService);
}

/**
 * Loads all locale files, checks for conflicts, renames the key in each JSON structure,
 * and writes the updated content back to disk.
 *
 * @param {string} projectRoot - The absolute path to the project root.
 * @param {string} oldKey - The original dot-separated key.
 * @param {string} newKey - The new dot-separated key.
 * @param {object} localeService - The locale service used to discover locale files.
 * @returns {Promise<void>}
 * @throws {Error} If the new key already exists in any locale file.
 */
async function _renameInLocaleFiles(projectRoot, oldKey, newKey, localeService) {
    const localeFiles = await _loadLocaleFiles(projectRoot, oldKey, newKey, localeService);
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

/**
 * Reads and parses all locale files from disk, returning an array of objects describing each file.
 * As a side effect, validates that the `newKey` does not already exist in any of them.
 *
 * @param {string} projectRoot - The absolute path to the project root.
 * @param {string} oldKey - The original dot-separated key to check presence for.
 * @param {string} newKey - The new dot-separated key to check for pre-existence.
 * @param {object} localeService - The locale service used to discover locale files.
 * @returns {Promise<Array<{uri: vscode.Uri, raw: string, json: object, hasOldKey: boolean, hasNewKey: boolean}>>}
 * @throws {Error} If the `newKey` already exists in any of the loaded locale files.
 */
async function _loadLocaleFiles(projectRoot, oldKey, newKey, localeService) {
    const localePaths = await getLocaleFilePaths(projectRoot, localeService);
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

/**
 * Finds all source files in the project, identifies translation calls matching the `oldKey`,
 * and applies the renaming. Files not currently open are written directly to disk, while the
 * active document's edits are staged in the provided `WorkspaceEdit`.
 *
 * @param {vscode.WorkspaceEdit} edit - The workspace edit to populate for the active document.
 * @param {vscode.TextDocument} activeDocument - The currently open text document.
 * @param {string} projectRoot - The absolute path to the project root.
 * @param {string} oldKey - The original translation key.
 * @param {string} newKey - The new translation key.
 * @param {object} translationService - Service to find translation calls in source text.
 * @returns {Promise<void>}
 */
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
 * Applies multiple call-site renames to a raw string, processing replacements from
 * end to start to preserve character offsets.
 *
 * @param {string} text - The original file content.
 * @param {Array<{keyType: string, start: number, end: number, methodName: string}>} calls - An array of call descriptors, sorted by their start offset ascending by the caller.
 * @param {string} newKey - The replacement key string.
 * @returns {string} The modified text content.
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
 * Calculates the character-offset span and the replacement string for a single translation call.
 * The logic differentiates between flat (`m.oldKey()`) and nested (`m["oldKey"]()`) call styles.
 *
 * @param {string} text - The source text containing the call.
 * @param {{keyType: string, start: number, end: number, methodName: string}} call - The call descriptor.
 * @param {string} newKey - The new key value to insert.
 * @returns {{ charStart: number, charEnd: number, replacement: string }} The range details for the replacement.
 */
function _buildCharReplacement(text, call, newKey) {
    if (call.keyType === 'flat') {
        if (newKey.includes('.')) {
            // m.oldKey()  ->  m["newKey"]()  : replace from the dot through end of method name
            return {
                charStart: call.start + 1,
                charEnd:   call.start + 2 + call.methodName.length,
                replacement: `["${newKey}"]`,
            };
        } else {
            // m.oldKey()  ->  m.newKey()  : replace just the method name portion
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
 * Constructs a VSCode Range and replacement text for a translation call within an open document.
 * This is a thin wrapper that converts the raw text offset logic into editor coordinates.
 *
 * @param {vscode.TextDocument} document - The document to create the edit for.
 * @param {{keyType: string, start: number, end: number, methodName: string}} call - The translation call descriptor.
 * @param {string} text - The full text of the document.
 * @param {string} newKey - The replacement key.
 * @returns {{ range: vscode.Range, replacement: string }} An object containing the range to replace and the new text.
 */
function _buildSourceEdit(document, call, text, newKey) {
    const { charStart, charEnd, replacement } = _buildCharReplacement(text, call, newKey);
    return {
        range: new vscode.Range(document.positionAt(charStart), document.positionAt(charEnd)),
        replacement,
    };
}

// helpers

/**
 * Reads a file from the given path with UTF-8 encoding.
 *
 * @param {string} filePath - The absolute path to the file.
 * @returns {Promise<string | null>} The file content as a string, or `null` if an error occurs (e.g., file not found).
 */
async function _readText(filePath) {
    try { return await fs.readFile(filePath, 'utf8'); } catch { return null; }
}

/**
 * Safely parses a JSON string into a plain object.
 *
 * @param {string} raw - The raw JSON string.
 * @returns {object | null} The parsed object, or `null` if the input is invalid or does not represent a non-array object.
 */
function _parseJson(raw) {
    try {
        const v = JSON.parse(raw);
        return typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch { return null; }
}

/**
 * Checks if a given key path exists within a nested object structure.
 *
 * @param {object} obj - The object to inspect.
 * @param {string} keyPath - A dot-separated path string to check.
 * @returns {boolean} `true` if the value at the path is not `undefined`, otherwise `false`.
 */
function _isKeyPresent(obj, keyPath) {
    return getNestedValue(obj, keyPath.split('.')) !== undefined;
}

module.exports = { buildRenameEdit, validateRenameKey };
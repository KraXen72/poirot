// @ts-check
/// <reference types="node" />
const vscode = require('vscode');
const path = require('path');
const { getLocaleFilePaths, getProjectRoot } = require('../utils/i18n-detection');
const { getNestedValue, stringifyJsonLike, renameJsonKey } = require('../utils/json-utils');
const { getOpenTextDocument, readTextDocumentOrFile } = require('../utils/text-edits');

const KEY_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_.]*$/;
const SOURCE_INCLUDE_GLOB = '**/*.{js,jsx,ts,tsx,svelte}';
const SOURCE_EXCLUDE_GLOB = '{node_modules,.git,paraglide}/**';
const PLANNING_CONCURRENCY = 24;

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
 * Builds full-file replacement plans for renaming a translation key (`oldKey` to `newKey`)
 * across locale and source files.
 *
 * @param {vscode.TextDocument} activeDocument - The text document that is currently active in the editor.
 * @param {string} oldKey - The original dot-separated translation key to rename.
 * @param {string} newKey - The new dot-separated translation key.
 * @param {object} translationService - A service object that must expose a `findTranslationCalls(text: string)` method.
 * @param {object} localeService - A service object that must expose a `getLocaleFilePaths(projectRoot: string)` method.
 * @returns {Promise<Array<{ uri: vscode.Uri, oldText: string, newText: string, edits?: Array<{ start: number, end: number, replacement: string }>, reason: string }>>}
 * @throws {Error} Throws a user-facing error if the project root cannot be found or if the operation fails.
 */
async function buildRenameChanges(activeDocument, oldKey, newKey, translationService, localeService) {
    if (oldKey === newKey) return [];

    const projectRoot = getProjectRoot(activeDocument);
    if (!projectRoot) throw new Error('Could not find inlang project root for this file.');

    const [localeChanges, sourceChanges] = await Promise.all([
        _renameInLocaleFiles(projectRoot, oldKey, newKey, localeService),
        _renameInSourceFiles(projectRoot, oldKey, newKey, translationService),
    ]);

    return [...localeChanges, ...sourceChanges];
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
    return localeFiles
        .filter(lf => lf.hasOldKey)
        .map(lf => {
            const updated = renameJsonKey(lf.json, oldKey, newKey);
            const content = stringifyJsonLike(lf.raw, updated);
            return {
                uri: lf.uri,
                oldText: lf.raw,
                newText: content,
                reason: `rename locale key in ${path.basename(lf.uri.fsPath)}`,
            };
        });
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
    const files = (await Promise.all(localePaths.map(async filePath => {
        const uri = vscode.Uri.file(filePath);
        const raw = await readTextDocumentOrFile(uri);
        if (raw == null) return null;
        const json = _parseJson(raw);
        if (json == null) return null;
        return {
            uri,
            raw,
            json,
            hasOldKey: _isKeyPresent(json, oldKey),
            hasNewKey: _isKeyPresent(json, newKey),
        };
    }))).filter(Boolean);

    for (const f of files) {
        if (f.hasNewKey) {
            throw new Error(`Key "${newKey}" already exists in ${path.basename(f.uri.fsPath)}. Rename aborted.`);
        }
    }
    return files;
}

/**
 * Finds all source files in the project, identifies translation calls matching the `oldKey`,
 * and builds replacement plans for files that contain matching calls.
 *
 * @param {string} projectRoot - The absolute path to the project root.
 * @param {string} oldKey - The original translation key.
 * @param {string} newKey - The new translation key.
 * @param {object} translationService - Service to find translation calls in source text.
 * @returns {Promise<Array<{ uri: vscode.Uri, oldText: string, newText: string, reason: string }>>}
 */
async function _renameInSourceFiles(projectRoot, oldKey, newKey, translationService) {
    const files = await _findSourceCandidateFiles(projectRoot, oldKey);
    const changes = await mapConcurrent(files, PLANNING_CONCURRENCY, async fileUri => {
        if (_isExcludedSourcePath(fileUri.fsPath)) return null;

        const raw = await readTextDocumentOrFile(fileUri);
        if (raw == null) return null;

        const calls = translationService.findTranslationCalls(raw).filter(c => c.methodName === oldKey);
        if (calls.length === 0) return null;

        const replacements = buildSourceRenameEdits(raw, calls, newKey);
        const newContent = applySourceReplacements(raw, replacements);
        const change = {
            uri: fileUri,
            oldText: raw,
            newText: newContent,
            reason: `rename source usages in ${path.basename(fileUri.fsPath)}`,
        };

        if (getOpenTextDocument(fileUri)) {
            change.edits = replacements;
        }

        return change;
    });

    return changes.filter(Boolean);
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
function applySourceReplacements(text, replacements) {
    const sorted = replacements.slice().sort((a, b) => b.start - a.start);
    let result = text;
    for (const edit of sorted) {
        result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    }
    return result;
}

/**
 * @param {string} text
 * @param {Array<{keyType: string, start: number, end: number, methodName: string}>} calls
 * @param {string} newKey
 * @returns {Array<{ start: number, end: number, replacement: string }>}
 */
function buildSourceRenameEdits(text, calls, newKey) {
    return calls.map(call => _buildCharReplacement(text, call, newKey));
}

/**
 * Calculates the character-offset span and the replacement string for a single translation call.
 * The logic differentiates between flat (`m.oldKey()`) and nested (`m["oldKey"]()`) call styles.
 *
 * @param {string} text - The source text containing the call.
 * @param {{keyType: string, start: number, end: number, methodName: string}} call - The call descriptor.
 * @param {string} newKey - The new key value to insert.
 * @returns {{ start: number, end: number, replacement: string }} The range details for the replacement.
 */
function _buildCharReplacement(text, call, newKey) {
    if (call.keyType === 'flat') {
        if (newKey.includes('.')) {
            // m.oldKey()  ->  m["newKey"]()  : replace from the dot through end of method name
            return {
                start: call.start + 1,
                end:   call.start + 2 + call.methodName.length,
                replacement: `["${newKey}"]`,
            };
        } else {
            // m.oldKey()  ->  m.newKey()  : replace just the method name portion
            return {
                start: call.start + 2,
                end:   call.start + 2 + call.methodName.length,
                replacement: newKey,
            };
        }
    }

    // nested: m["oldKey"]()
    const matchText = text.slice(call.start, call.end);
    const nestedMatch = /\[(["'`])([^"'`]+)\1\]/.exec(matchText);
    if (!nestedMatch) {
        return { start: call.start, end: call.end, replacement: newKey };
    }
    const keyOffset = matchText.indexOf(nestedMatch[2]);
    return {
        start: call.start + keyOffset,
        end:   call.start + keyOffset + nestedMatch[2].length,
        replacement: newKey,
    };
}

// helpers

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

/**
 * @param {string} projectRoot
 * @param {string} oldKey
 * @returns {Promise<vscode.Uri[]>}
 */
async function _findSourceCandidateFiles(projectRoot, oldKey) {
    const fromSearch = await _findSourceFilesContainingKey(projectRoot, oldKey);
    if (fromSearch.length > 0) {
        return fromSearch;
    }

    return vscode.workspace.findFiles(
        new vscode.RelativePattern(projectRoot, SOURCE_INCLUDE_GLOB),
        new vscode.RelativePattern(projectRoot, SOURCE_EXCLUDE_GLOB),
    );
}

/**
 * @param {string} projectRoot
 * @param {string} oldKey
 * @returns {Promise<vscode.Uri[]>}
 */
async function _findSourceFilesContainingKey(projectRoot, oldKey) {
    const uris = new Map();
    try {
        await vscode.workspace.findTextInFiles(
            { pattern: oldKey, isRegExp: false, isCaseSensitive: true },
            {
                include: new vscode.RelativePattern(projectRoot, SOURCE_INCLUDE_GLOB),
                exclude: new vscode.RelativePattern(projectRoot, SOURCE_EXCLUDE_GLOB),
            },
            result => {
                uris.set(result.uri.toString(), result.uri);
            },
        );
    } catch {
        return [];
    }

    for (const document of vscode.workspace.textDocuments) {
        if (_isSourceDocumentInProject(document, projectRoot) && document.getText().includes(oldKey)) {
            uris.set(document.uri.toString(), document.uri);
        }
    }

    return [...uris.values()];
}

/**
 * @param {vscode.TextDocument} document
 * @param {string} projectRoot
 * @returns {boolean}
 */
function _isSourceDocumentInProject(document, projectRoot) {
    if (!['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'svelte'].includes(document.languageId)) {
        return false;
    }

    return document.uri.fsPath.startsWith(projectRoot) && !_isExcludedSourcePath(document.uri.fsPath);
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function _isExcludedSourcePath(filePath) {
    return filePath.includes(`${path.sep}paraglide${path.sep}`)
        || filePath.includes(`${path.sep}node_modules${path.sep}`)
        || filePath.includes(`${path.sep}.git${path.sep}`);
}

/**
 * @template T,U
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<U>} mapper
 * @returns {Promise<U[]>}
 */
async function mapConcurrent(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index]);
        }
    });

    await Promise.all(workers);
    return results;
}

module.exports = {
    applySourceReplacements,
    buildSourceRenameEdits,
    buildRenameChanges,
    validateRenameKey,
};

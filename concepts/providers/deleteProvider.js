// @ts-check
const vscode = require('vscode');
const path = require('path');
const { deleteJsonKey, flattenJsonKeys, getNestedValue, stringifyJsonLike } = require('../utils/json-utils');
const { readTextDocumentOrFile } = require('../utils/text-edits');

const SOURCE_GLOB = '**/*.{js,jsx,ts,tsx,svelte}';
const SOURCE_EXCLUDE_GLOB = '{node_modules,.git,paraglide}/**';
const IDENTIFIER_KEY = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/**
 * @typedef {{ uri: vscode.Uri, raw: string, json: object, locale: string | null, hasKey: boolean }} LocaleFile
 * @typedef {{ uri: vscode.Uri, raw: string, calls: Array<{ methodName: string, start: number, end: number, keyType: string }> }} SourceUsageFile
 * @typedef {{ projectRoot: string, key: string, inlineValue: string | null, localeFiles: LocaleFile[], sourceFiles: SourceUsageFile[] }} DeleteKeyPlan
 */

/**
 * @param {string} projectRoot
 * @param {string} key
 * @param {object} translationService
 * @param {object} localeService
 * @returns {Promise<DeleteKeyPlan>}
 */
async function createDeleteKeyPlan(projectRoot, key, translationService, localeService) {
    const localeFiles = await loadLocaleFiles(projectRoot, localeService, key);
    const localeFilesWithKey = localeFiles.filter(file => file.hasKey);
    if (localeFilesWithKey.length === 0) {
        throw new Error(`Key "${key}" was not found in any locale file.`);
    }

    const sourceFiles = await findSourceUsageFiles(projectRoot, key, translationService);
    const inlineValue = countCalls(sourceFiles) > 0
        ? await resolveInlineValue(key, localeFilesWithKey, translationService, localeService)
        : null;
    if (countCalls(sourceFiles) > 0 && typeof inlineValue !== 'string') {
        throw new Error(`Key "${key}" has source usages but no string value in any locale. Delete aborted.`);
    }

    return {
        projectRoot,
        key,
        inlineValue,
        localeFiles: localeFilesWithKey,
        sourceFiles,
    };
}

/**
 * @param {DeleteKeyPlan} plan
 * @returns {Array<{ uri: vscode.Uri, oldText: string, newText: string, reason: string }>}
 */
function buildDeleteChanges(plan) {
    return [
        ...inlineSourceUsages(plan),
        ...deleteFromLocaleFiles(plan),
    ];
}

/**
 * @param {string} projectRoot
 * @param {object} localeService
 * @returns {Promise<string[]>}
 */
async function collectLocaleKeys(projectRoot, localeService) {
    const localeFiles = await loadLocaleFiles(projectRoot, localeService);
    return [...new Set(localeFiles.flatMap(file => flattenJsonKeys(file.json)))].sort();
}

/**
 * Opens VS Code search with a regex that matches supported source usage forms.
 *
 * @param {string} projectRoot
 * @param {string} key
 * @returns {Promise<void>}
 */
async function openUsageSearch(projectRoot, key) {
    await vscode.commands.executeCommand('workbench.action.findInFiles', {
        query: buildUsageSearchRegex(key),
        isRegex: true,
        triggerSearch: true,
        filesToInclude: buildSearchIncludeGlob(projectRoot),
        filesToExclude: SOURCE_EXCLUDE_GLOB,
    });
}

/**
 * @param {string} key
 * @returns {string}
 */
function buildUsageSearchRegex(key) {
    const escapedKey = escapeRegex(key);
    const bracketCalls = [
        String.raw`m\u005B"${escapedKey}"\u005D\s*\(.*\)`,
        String.raw`m\u005B'${escapedKey}'\u005D\s*\(.*\)`,
        String.raw`m\u005B` + '`' + escapedKey + '`' + String.raw`\u005D\s*\(.*\)`,
    ];

    const calls = IDENTIFIER_KEY.test(key)
        ? [String.raw`m\.${escapedKey}\s*\(.*\)`, ...bracketCalls]
        : bracketCalls;

    return String.raw`[{]?(?:${calls.join('|')})[}]?`;
}

/**
 * @param {string} projectRoot
 * @returns {string}
 */
function buildSearchIncludeGlob(projectRoot) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectRoot));
    if (!workspaceFolder || workspaceFolder.uri.fsPath === projectRoot) {
        return SOURCE_GLOB;
    }

    const relativeRoot = path.relative(workspaceFolder.uri.fsPath, projectRoot).replace(/\\/g, '/');
    return `${relativeRoot}/${SOURCE_GLOB}`;
}

/**
 * @param {string} projectRoot
 * @param {object} localeService
 * @param {string | null} key
 * @returns {Promise<LocaleFile[]>}
 */
async function loadLocaleFiles(projectRoot, localeService, key = null) {
    const localePaths = await getLocalePathsByLocale(projectRoot, localeService);
    const files = [];

    for (const localePath of localePaths) {
        const uri = vscode.Uri.file(localePath.filePath);
        const raw = await readTextDocumentOrFile(uri);
        if (raw == null) continue;

        let json;
        try {
            json = JSON.parse(raw);
        } catch {
            throw new Error(`Could not parse locale JSON: ${path.basename(localePath.filePath)}`);
        }

        if (!json || typeof json !== 'object' || Array.isArray(json)) continue;

        files.push({
            uri,
            raw,
            json,
            locale: localePath.locale,
            hasKey: key ? getNestedValue(json, key.split('.')) !== undefined : false,
        });
    }

    return files;
}

/**
 * @param {string} projectRoot
 * @param {object} localeService
 * @returns {Promise<Array<{ locale: string, filePath: string }>>}
 */
async function getLocalePathsByLocale(projectRoot, localeService) {
    const locales = await localeService.getAvailableLocales(projectRoot);
    const localePaths = [];

    for (const locale of locales) {
        const filePath = await localeService.resolveTranslationPathAsync(projectRoot, locale);
        localePaths.push({ locale, filePath });
    }

    return localePaths;
}

/**
 * @param {string} key
 * @param {LocaleFile[]} localeFiles
 * @param {object} translationService
 * @param {object} localeService
 * @returns {Promise<string | null>}
 */
async function resolveInlineValue(key, localeFiles, translationService, localeService) {
    const currentLocale = await localeService.getCurrentLocale();
    const currentFile = localeFiles.find(file => file.locale === currentLocale);
    const currentValue = currentFile ? translationService.getTranslation(currentFile.json, key) : null;
    if (typeof currentValue === 'string') {
        return currentValue;
    }

    for (const file of localeFiles) {
        const value = translationService.getTranslation(file.json, key);
        if (typeof value === 'string') {
            return value;
        }
    }

    return null;
}

/**
 * @param {string} projectRoot
 * @param {string} key
 * @param {object} translationService
 * @returns {Promise<SourceUsageFile[]>}
 */
async function findSourceUsageFiles(projectRoot, key, translationService) {
    const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(projectRoot, SOURCE_GLOB),
        new vscode.RelativePattern(projectRoot, SOURCE_EXCLUDE_GLOB),
    );

    const usageFiles = [];
    for (const uri of files) {
        const raw = await readTextDocumentOrFile(uri);
        if (raw == null) continue;

        const calls = translationService.findTranslationCalls(raw)
            .filter(call => call.methodName === key)
            .map(call => {
                const end = findBalancedCallEnd(raw, call);
                if (end == null) {
                    throw new Error(`Could not safely parse call for "${key}" in ${path.basename(uri.fsPath)}. Delete aborted.`);
                }

                return { ...call, end };
            });
        if (calls.length === 0) continue;

        usageFiles.push({ uri, raw, calls });
    }

    return usageFiles;
}

/**
 * @param {DeleteKeyPlan} plan
 * @returns {Array<{ uri: vscode.Uri, oldText: string, newText: string, reason: string }>}
 */
function inlineSourceUsages(plan) {
    if (plan.sourceFiles.length === 0 || typeof plan.inlineValue !== 'string') {
        return [];
    }

    const replacement = JSON.stringify(plan.inlineValue);
    return plan.sourceFiles.map(file => {
        const content = applyCallReplacements(file.raw, file.calls, replacement);
        return {
            uri: file.uri,
            oldText: file.raw,
            newText: content,
            reason: `inline deleted key in ${path.basename(file.uri.fsPath)}`,
        };
    });
}

/**
 * @param {DeleteKeyPlan} plan
 * @returns {Array<{ uri: vscode.Uri, oldText: string, newText: string, reason: string }>}
 */
function deleteFromLocaleFiles(plan) {
    return plan.localeFiles.map(file => {
        const updated = deleteJsonKey(file.json, plan.key);
        const content = stringifyJsonLike(file.raw, updated);
        return {
            uri: file.uri,
            oldText: file.raw,
            newText: content,
            reason: `delete locale key in ${path.basename(file.uri.fsPath)}`,
        };
    });
}

/**
 * @param {string} text
 * @param {Array<{ start: number, end: number }>} calls
 * @param {string} replacement
 * @returns {string}
 */
function applyCallReplacements(text, calls, replacement) {
    return calls
        .slice()
        .sort((a, b) => b.start - a.start)
        .reduce((result, call) => result.slice(0, call.start) + replacement + result.slice(call.end), text);
}

/**
 * @param {string} text
 * @param {{ start: number, end: number, methodName: string }} call
 * @returns {number | null}
 */
function findBalancedCallEnd(text, call) {
    const openParen = findCallOpenParen(text, call);
    if (openParen === -1 || openParen > call.end) {
        return null;
    }

    let depth = 0;
    for (let index = openParen; index < text.length; index++) {
        const char = text[index];

        if (char === '"' || char === '\'' || char === '`') {
            index = skipQuotedString(text, index, char);
            if (index == null) return null;
            continue;
        }

        if (char === '/' && text[index + 1] === '/') {
            const newline = text.indexOf('\n', index + 2);
            if (newline === -1) return null;
            index = newline;
            continue;
        }

        if (char === '/' && text[index + 1] === '*') {
            const commentEnd = text.indexOf('*/', index + 2);
            if (commentEnd === -1) return null;
            index = commentEnd + 1;
            continue;
        }

        if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
            if (depth === 0) {
                return index + 1;
            }
        }
    }

    return null;
}

/**
 * @param {string} text
 * @param {{ start: number, methodName: string, keyType?: string }} call
 * @returns {number}
 */
function findCallOpenParen(text, call) {
    if (call.keyType === 'flat') {
        return text.indexOf('(', call.start + 2 + call.methodName.length);
    }

    const closingBracket = text.indexOf(']', call.start);
    if (closingBracket === -1) {
        return -1;
    }

    return text.indexOf('(', closingBracket);
}

/**
 * @param {string} text
 * @param {number} start
 * @param {string} quote
 * @returns {number | null}
 */
function skipQuotedString(text, start, quote) {
    for (let index = start + 1; index < text.length; index++) {
        if (text[index] === '\\') {
            index++;
            continue;
        }

        if (text[index] === quote) {
            return index;
        }
    }

    return null;
}

/**
 * @param {DeleteKeyPlan} plan
 * @returns {number}
 */
function countSourceUsages(plan) {
    return countCalls(plan.sourceFiles);
}

/**
 * @param {SourceUsageFile[]} sourceFiles
 * @returns {number}
 */
function countCalls(sourceFiles) {
    return sourceFiles.reduce((total, file) => total + file.calls.length, 0);
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    applyCallReplacements,
    buildDeleteChanges,
    buildUsageSearchRegex,
    collectLocaleKeys,
    countSourceUsages,
    createDeleteKeyPlan,
    findBalancedCallEnd,
    getLocalePathsByLocale,
    openUsageSearch,
};

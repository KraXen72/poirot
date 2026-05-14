/// <reference types="node" />
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

/**
 * @typedef {{ locales?: string[], baseLocale?: string, [key: string]: unknown }} InlangSettings
 * @typedef {{ methodName: string, params: string, start: number, end: number, keyType: 'flat' | 'nested' }} TranslationCall
 */

/**
 * @param {import('vscode').TextDocument} document
 * @param {import('vscode').Position} position
 * @param {object} translationService
 * @returns {string | null}
 */
function getKeyAtPosition(document, position, translationService) {
    const call = getTranslationCallAtPosition(document, position, translationService);
    return call ? call.methodName : null;
}

/**
 * @param {import('vscode').TextDocument} document
 * @param {import('vscode').Position} position
 * @param {object} translationService
 * @returns {TranslationCall | null}
 */
function getTranslationCallAtPosition(document, position, translationService) {
    const line = document.lineAt(position.line).text;

    /** @type {TranslationCall[]} */
    const calls = translationService.findTranslationCalls(line);

    for (const call of calls) {
        const keyRange = getCallKeyRange(line, call);
        if (position.character >= keyRange.start && position.character <= keyRange.end) {
            return call;
        }
    }

    return null;
}

/**
 * @param {import('vscode').TextDocument} document
 * @param {import('vscode').Position} position
 * @param {object} translationService
 * @returns {import('vscode').Range}
 */
function getKeyRangeAtPosition(document, position, translationService) {
    const call = getTranslationCallAtPosition(document, position, translationService);
    if (!call) {
        return document.getWordRangeAtPosition(position) ?? new vscode.Range(position, position);
    }

    const line = document.lineAt(position.line).text;
    const keyRange = getCallKeyRange(line, call);
    return new vscode.Range(position.line, keyRange.start, position.line, keyRange.end);
}

/**
 * @param {string} line
 * @param {TranslationCall} call
 * @returns {{ start: number, end: number }}
 */
function getCallKeyRange(line, call) {
    if (call.keyType === 'flat') {
        return {
            start: call.start + 2,
            end: call.start + 2 + call.methodName.length,
        };
    }

    const matchText = line.slice(call.start, call.end);
    const bracketMatch = /\bm\[(["'`])([^"'`]+)\1\]\s*\(/.exec(matchText);
    if (!bracketMatch) {
        return { start: call.start, end: call.end };
    }

    const start = call.start + matchText.indexOf(bracketMatch[2]);
    return { start, end: start + bracketMatch[2].length };
}

/**
 * @param {import('vscode').TextDocument} document
 * @returns {string | null}
 */
function getProjectRoot(document) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
        return null;
    }

    let currentDir = path.dirname(document.uri.fsPath);
    const workspaceRoot = workspaceFolder.uri.fsPath;

    while (currentDir.length >= workspaceRoot.length) {
        const projectInlangPath = path.join(currentDir, 'project.inlang', 'settings.json');
        if (fs.existsSync(projectInlangPath)) {
            return currentDir;
        }

        const legacyInlangPath = path.join(currentDir, 'inlang.project', 'settings.json');
        if (fs.existsSync(legacyInlangPath)) {
            return currentDir;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            break;
        }

        currentDir = parentDir;
    }

    return workspaceRoot;
}

/**
 * @param {string} projectRoot
 * @param {object} localeService
 * @returns {Promise<string[]>}
 */
async function getLocaleFilePaths(projectRoot, localeService) {
    return localeService.getLocaleFilePaths(projectRoot);
}

module.exports = {
    getKeyAtPosition,
    getKeyRangeAtPosition,
    getLocaleFilePaths,
    getProjectRoot,
};

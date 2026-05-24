const vscode = require('vscode');

/**
 * @param {vscode.Uri} uri
 * @returns {vscode.TextDocument | null}
 */
function getOpenTextDocument(uri) {
    return vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString()) || null;
}

/**
 * @param {vscode.WorkspaceEdit} edit
 * @returns {boolean}
 */
function hasWorkspaceEdits(edit) {
    return typeof edit.size === 'number' ? edit.size > 0 : false;
}

/**
 * @param {vscode.Uri} uri
 * @returns {Promise<string | null>}
 */
async function readTextDocumentOrFile(uri) {
    const openDocument = getOpenTextDocument(uri);
    if (openDocument?.isDirty) {
        return openDocument.getText();
    }

    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(bytes).toString('utf8');
    } catch {
        return null;
    }
}

/**
 * Writes content directly unless the file is open with unsaved changes, in which case it
 * uses a WorkspaceEdit so the in-memory buffer remains the source of truth.
 *
 * @param {vscode.WorkspaceEdit} edit
 * @param {vscode.Uri} uri
 * @param {string} content
 * @returns {Promise<'workspaceEdit' | 'fileWrite'>}
 */
async function stageOrWriteTextFile(edit, uri, content) {
    const openDocument = getOpenTextDocument(uri);
    if (openDocument?.isDirty) {
        const fullRange = new vscode.Range(
            openDocument.positionAt(0),
            openDocument.positionAt(openDocument.getText().length),
        );
        edit.replace(uri, fullRange, content);
        return 'workspaceEdit';
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    return 'fileWrite';
}

/**
 * @param {vscode.WorkspaceEdit} edit
 * @param {vscode.TextDocument} document
 * @param {vscode.Range} range
 * @param {string} replacement
 * @returns {Promise<'workspaceEdit' | 'fileWrite'>}
 */
async function stageOrWriteDocumentRange(edit, document, range, replacement) {
    if (document.isDirty) {
        edit.replace(document.uri, range, replacement);
        return 'workspaceEdit';
    }

    const text = document.getText();
    const start = document.offsetAt(range.start);
    const end = document.offsetAt(range.end);
    const updated = text.slice(0, start) + replacement + text.slice(end);
    await vscode.workspace.fs.writeFile(document.uri, Buffer.from(updated, 'utf8'));
    return 'fileWrite';
}

module.exports = {
    getOpenTextDocument,
    hasWorkspaceEdits,
    readTextDocumentOrFile,
    stageOrWriteDocumentRange,
    stageOrWriteTextFile,
};

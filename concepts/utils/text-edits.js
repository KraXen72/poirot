const vscode = require('vscode');

class TextFileChangeTransactionError extends Error {
    /**
     * @param {string} message
     * @param {{ phase: 'forward' | 'rollback', rollbackSucceeded?: boolean, manualResolutionUri?: vscode.Uri, cause?: unknown }} details
     */
    constructor(message, details) {
        super(message);
        this.name = 'TextFileChangeTransactionError';
        this.phase = details.phase;
        this.rollbackSucceeded = details.rollbackSucceeded ?? false;
        this.manualResolutionUri = details.manualResolutionUri || null;
        this.cause = details.cause;
    }
}

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
 * Applies planned full-file replacements sequentially. If a later operation fails,
 * previously applied changes are rolled back only while their content/version still
 * matches what this transaction wrote.
 *
 * @param {Array<{ uri: vscode.Uri, oldText: string, newText: string, reason?: string }>} changes
 * @returns {Promise<{ applied: number, skipped: number }>}
 */
async function applyTextFileChanges(changes) {
    const rollbackActions = [];
    let skipped = 0;

    for (const change of changes) {
        if (change.oldText === change.newText) {
            skipped++;
            continue;
        }

        try {
            const rollback = await applyOneTextFileChange(change);
            rollbackActions.push(rollback);
        } catch (error) {
            await rollbackAppliedChanges(rollbackActions, error);
        }
    }

    return { applied: rollbackActions.length, skipped };
}

/**
 * @param {{ uri: vscode.Uri, oldText: string, newText: string, reason?: string }} change
 * @returns {Promise<() => Promise<void>>}
 */
async function applyOneTextFileChange(change) {
    const openDocument = getOpenTextDocument(change.uri);
    if (openDocument?.isDirty) {
        return applyDirtyDocumentChange(openDocument, change);
    }

    return applyDirectWriteChange(change);
}

/**
 * @param {vscode.TextDocument} document
 * @param {{ uri: vscode.Uri, oldText: string, newText: string, reason?: string }} change
 * @returns {Promise<() => Promise<void>>}
 */
async function applyDirtyDocumentChange(document, change) {
    if (document.getText() !== change.oldText) {
        throw new Error(buildChangedBeforeApplyMessage(change));
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(change.uri, fullDocumentRange(document, change.oldText), change.newText);

    const success = await vscode.workspace.applyEdit(edit);
    if (!success) {
        throw new Error(`Could not apply edit for ${describeChange(change)}.`);
    }

    const changedDocument = getOpenTextDocument(change.uri);
    if (!changedDocument || changedDocument.getText() !== change.newText) {
        throw new Error(`Could not verify edit for ${describeChange(change)}.`);
    }

    const versionAfterEdit = changedDocument.version;
    return async () => {
        const currentDocument = getOpenTextDocument(change.uri);
        if (!currentDocument || currentDocument.version !== versionAfterEdit || currentDocument.getText() !== change.newText) {
            throw new Error(`Manual resolution required for ${describeChange(change)}; the dirty buffer changed after ElementaryWatson edited it.`);
        }

        const rollbackEdit = new vscode.WorkspaceEdit();
        rollbackEdit.replace(change.uri, fullDocumentRange(currentDocument, change.newText), change.oldText);
        const rollbackSuccess = await vscode.workspace.applyEdit(rollbackEdit);
        if (!rollbackSuccess) {
            throw new Error(`Could not rollback edit for ${describeChange(change)}.`);
        }
    };
}

/**
 * @param {{ uri: vscode.Uri, oldText: string, newText: string, reason?: string }} change
 * @returns {Promise<() => Promise<void>>}
 */
async function applyDirectWriteChange(change) {
    const currentText = await readDiskText(change.uri);
    if (currentText !== change.oldText) {
        throw new Error(buildChangedBeforeApplyMessage(change));
    }

    await vscode.workspace.fs.writeFile(change.uri, Buffer.from(change.newText, 'utf8'));
    return async () => {
        const textAfterWrite = await readDiskText(change.uri);
        if (textAfterWrite !== change.newText) {
            throw new Error(`Manual resolution required for ${describeChange(change)}; the file changed after ElementaryWatson wrote it.`);
        }

        await vscode.workspace.fs.writeFile(change.uri, Buffer.from(change.oldText, 'utf8'));
    };
}

/**
 * @param {Array<() => Promise<void>>} rollbackActions
 * @param {unknown} forwardError
 * @returns {Promise<never>}
 */
async function rollbackAppliedChanges(rollbackActions, forwardError) {
    try {
        for (const rollback of rollbackActions.slice().reverse()) {
            await rollback();
        }
    } catch (rollbackError) {
        throw new TextFileChangeTransactionError(
            `Forward change failed and rollback could not be completed. ${getErrorMessage(rollbackError)}`,
            { phase: 'rollback', rollbackSucceeded: false, cause: rollbackError },
        );
    }

    throw new TextFileChangeTransactionError(
        `Forward change failed; already-applied changes were rolled back. ${getErrorMessage(forwardError)}`,
        { phase: 'forward', rollbackSucceeded: true, cause: forwardError },
    );
}

/**
 * @param {vscode.Uri} uri
 * @returns {Promise<string>}
 */
async function readDiskText(uri) {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
}

/**
 * @param {vscode.TextDocument} document
 * @param {string} text
 * @returns {vscode.Range}
 */
function fullDocumentRange(document, text) {
    return new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length),
    );
}

/**
 * @param {{ uri: vscode.Uri, reason?: string }} change
 * @returns {string}
 */
function describeChange(change) {
    return change.reason || change.uri.fsPath || change.uri.toString();
}

/**
 * @param {{ uri: vscode.Uri, reason?: string }} change
 * @returns {string}
 */
function buildChangedBeforeApplyMessage(change) {
    return `Skipped ${describeChange(change)} because its content changed after planning.`;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
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
    applyTextFileChanges,
    getOpenTextDocument,
    hasWorkspaceEdits,
    readTextDocumentOrFile,
    stageOrWriteDocumentRange,
    stageOrWriteTextFile,
    TextFileChangeTransactionError,
};

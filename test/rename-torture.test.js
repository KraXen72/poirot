const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const { renameJsonKey, stringifyJsonLike } = require('../concepts/utils/json-utils');
const { buildSourceRenameEdits, applySourceReplacements } = require('../concepts/providers/renameProvider');
const { applyTextFileChanges } = require('../concepts/utils/text-edits');

// ---- Fixtures ----

const FIXTURES = {
    en: { key_one: 'One', key_two: 'Two', key_three: 'Three', key_four: 'Four', key_five: 'Five' },
    'pt-PT': { key_one: 'Um', key_two: 'Dois', key_three: 'Três', key_four: 'Quatro', key_five: 'Cinco' },
    es: { key_one: 'Uno', key_two: 'Dos', key_three: 'Tres', key_four: 'Cuatro', key_five: 'Cinco' },
};

const SOURCE_CONTENT = [
    "import * as m from './paraglide/messages.js';",
    '',
    'const header = m.key_one();',
    'const subtitle = m.key_two({ count: items.length });',
    'const body = m.key_three();',
    'const footer = m.key_four();',
    'const copyright = m.key_five({ year: 2026 });',
    '',
].join('\n');

const RENAMES = [
    { oldKey: 'key_one', newKey: 'title' },
    { oldKey: 'key_three', newKey: 'page.heading' },
    { oldKey: 'key_five', newKey: 'footer.copyright' },
];

// ---- Helpers ----

function findTranslationCalls(text) {
    const calls = [];
    const re = /m(?:\.([a-zA-Z_$][a-zA-Z0-9_$]*)|\[\s*(["'`])([^"'`]+)\2\s*\])/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        const methodName = match[1] !== undefined ? match[1] : match[3];
        calls.push({
            methodName,
            start: match.index,
            end: match.index + match[0].length,
            keyType: match[1] !== undefined ? 'flat' : 'nested',
        });
    }
    return calls;
}

function buildLocaleChange(raw, json, oldKey, newKey, uri) {
    const updated = renameJsonKey(json, oldKey, newKey);
    return {
        uri,
        oldText: raw,
        newText: stringifyJsonLike(raw, updated),
        reason: `rename ${oldKey} to ${newKey}`,
    };
}

function buildSourceChange(text, oldKey, newKey, uri) {
    const calls = findTranslationCalls(text).filter(c => c.methodName === oldKey);
    if (calls.length === 0) return null;
    const edits = buildSourceRenameEdits(text, calls, newKey);
    return {
        uri,
        oldText: text,
        newText: applySourceReplacements(text, edits),
        edits,
        reason: `rename ${oldKey} to ${newKey}`,
    };
}

async function createFixtureWorkspace() {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ew-torture-'));
    const localeDir = path.join(dir, 'messages');
    await fs.promises.mkdir(localeDir, { recursive: true });

    const fileUris = {};
    for (const [locale, json] of Object.entries(FIXTURES)) {
        const filePath = path.join(localeDir, `${locale}.json`);
        await fs.promises.writeFile(filePath, JSON.stringify(json, null, 2) + '\n', 'utf8');
        fileUris[locale] = vscode.Uri.file(filePath);
    }
    const sourcePath = path.join(dir, 'app.js');
    await fs.promises.writeFile(sourcePath, SOURCE_CONTENT, 'utf8');
    fileUris.source = vscode.Uri.file(sourcePath);

    return { dir, fileUris };
}

async function readFile(uri) {
    return fs.promises.readFile(uri.fsPath, 'utf8');
}

function makeDirty(document, editDescription) {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
    );
    edit.replace(document.uri, fullRange, editDescription(document.getText()));
    return vscode.workspace.applyEdit(edit);
}

function addTrailingNewline(text) {
    return text.endsWith('\n') ? text + '\n' : text + '\n\n';
}

async function currentLocaleRaw(uri, doc) {
    return doc && doc.isDirty ? doc.getText() : readFile(uri);
}

async function currentSourceRaw(uri, doc) {
    return doc ? doc.getText() : readFile(uri);
}

function expectedTopKeysAfter(count) {
    const all = new Set(Object.keys(FIXTURES.en));
    for (let i = 0; i < count; i++) {
        all.delete(RENAMES[i].oldKey);
        all.add(RENAMES[i].newKey.split('.')[0]);
    }
    return [...all].sort();
}

function expectedSourcePatternsAfter(count) {
    return RENAMES.slice(0, count).map(r =>
        r.newKey.includes('.') ? `["${r.newKey}"]` : `.${r.newKey}(`
    );
}

const FILE_ORDER = ['en', 'pt-PT', 'es', 'source'];
const FILE_COUNT = FILE_ORDER.length;

// ---- Matrix-generated torture tests ----

suite('rename torture tests', () => {
    const ratios = [0, 0.5, 1];
    const renameCounts = [1, 2, 3];

    for (const openRatio of ratios) {
        for (const dirtyRatio of ratios) {
            if (openRatio === 0 && dirtyRatio > 0) continue;

            const openCount = Math.round(FILE_COUNT * openRatio);
            const dirtyCount = Math.round(openCount * dirtyRatio);

            for (const renameCount of renameCounts) {
                const label = `renames ${renameCount} key${renameCount > 1 ? 's' : ''} `
                    + `when ${openCount}/${FILE_COUNT} files open, ${dirtyCount}/${openCount} of those dirty`;

                test(label, async () => {
                    const { fileUris, dir } = await createFixtureWorkspace();
                    const openDocs = { en: null, 'pt-PT': null, es: null, source: null };

                    try {
                        const openFiles = FILE_ORDER.slice(0, openCount);
                        for (const key of openFiles) {
                            openDocs[key] = await vscode.workspace.openTextDocument(fileUris[key]);
                        }

                        const dirtyFiles = openFiles.slice(0, dirtyCount);
                        for (const key of dirtyFiles) {
                            await makeDirty(openDocs[key], addTrailingNewline);
                        }

                        for (let i = 0; i < renameCount; i++) {
                            const { oldKey, newKey } = RENAMES[i];
                            const changes = [];

                            for (const locale of Object.keys(FIXTURES)) {
                                const uri = fileUris[locale];
                                const raw = await currentLocaleRaw(uri, openDocs[locale]);
                                changes.push(buildLocaleChange(raw, JSON.parse(raw), oldKey, newKey, uri));
                            }

                            const srcText = await currentSourceRaw(fileUris.source, openDocs.source);
                            const srcChange = buildSourceChange(srcText, oldKey, newKey, fileUris.source);
                            if (srcChange) changes.push(srcChange);

                            await applyTextFileChanges(changes);
                        }

                        // Verify locale files
                        const expected = expectedTopKeysAfter(renameCount);
                        for (const locale of Object.keys(FIXTURES)) {
                            const doc = openDocs[locale];
                            if (doc && doc.isDirty) {
                                assert.deepStrictEqual(
                                    Object.keys(JSON.parse(doc.getText())).sort(),
                                    expected,
                                    `${locale} dirty buffer keys`,
                                );
                            } else {
                                assert.deepStrictEqual(
                                    Object.keys(JSON.parse(await readFile(fileUris[locale]))).sort(),
                                    expected,
                                    `${locale} disk keys`,
                                );
                            }
                        }

                        // Verify source file
                        const srcText = openDocs.source
                            ? openDocs.source.getText()
                            : await readFile(fileUris.source);
                        const patterns = expectedSourcePatternsAfter(renameCount);
                        for (const p of patterns) {
                            assert.notStrictEqual(srcText.includes(p), false,
                                `source should contain ${p}`);
                        }
                        if (renameCount < RENAMES.length) {
                            const stillOriginal = RENAMES[renameCount];
                            assert.notStrictEqual(
                                srcText.includes(`m.${stillOriginal.oldKey}(`),
                                false,
                                `source should retain original key "${stillOriginal.oldKey}"`
                            );
                        }
                    } finally {
                        await fs.promises.rm(dir, { recursive: true, force: true });
                    }
                });
            }
        }
    }

    // Concurrent-modification test (doesn't fit the matrix)
    test('rolls back all changes when a locale file is modified during rename', async () => {
        const { fileUris, dir } = await createFixtureWorkspace();

        try {
            const { oldKey, newKey } = RENAMES[0];
            const changes = [];

            for (const locale of Object.keys(FIXTURES)) {
                const uri = fileUris[locale];
                const raw = await readFile(uri);
                changes.push(buildLocaleChange(raw, JSON.parse(raw), oldKey, newKey, uri));
            }
            const srcText = await readFile(fileUris.source);
            const srcChange = buildSourceChange(srcText, oldKey, newKey, fileUris.source);
            if (srcChange) changes.push(srcChange);

            await fs.promises.writeFile(fileUris.en.fsPath,
                JSON.stringify({ replaced: 'during rename' }, null, 2) + '\n', 'utf8');

            await assert.rejects(
                () => applyTextFileChanges(changes),
                /changed after planning|rolled back/,
            );

            assert.deepStrictEqual(JSON.parse(await readFile(fileUris['pt-PT'])), FIXTURES['pt-PT']);
            assert.deepStrictEqual(JSON.parse(await readFile(fileUris.es)), FIXTURES.es);
            assert.deepStrictEqual(
                JSON.parse(await readFile(fileUris.en)),
                { replaced: 'during rename' },
            );
            assert.strictEqual(await readFile(fileUris.source), SOURCE_CONTENT);
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });

    // Retry-after-failure test (doesn't fit the matrix)
    test('retry succeeds after a failed rename when conflict is resolved', async () => {
        const { fileUris, dir } = await createFixtureWorkspace();

        try {
            const { oldKey, newKey } = RENAMES[0];
            const changes = [];

            for (const locale of Object.keys(FIXTURES)) {
                const uri = fileUris[locale];
                const raw = await readFile(uri);
                changes.push(buildLocaleChange(raw, JSON.parse(raw), oldKey, newKey, uri));
            }
            const srcText = await readFile(fileUris.source);
            const srcChange = buildSourceChange(srcText, oldKey, newKey, fileUris.source);
            if (srcChange) changes.push(srcChange);

            await fs.promises.writeFile(fileUris.en.fsPath,
                JSON.stringify({ replaced: 'during rename' }, null, 2) + '\n', 'utf8');

            await assert.rejects(
                () => applyTextFileChanges(changes),
                /changed after planning|rolled back/,
            );

            await fs.promises.writeFile(fileUris.en.fsPath,
                JSON.stringify(FIXTURES.en, null, 2) + '\n', 'utf8');

            const retryChanges = [];
            for (const locale of Object.keys(FIXTURES)) {
                const uri = fileUris[locale];
                const raw = await readFile(uri);
                retryChanges.push(buildLocaleChange(raw, JSON.parse(raw), oldKey, newKey, uri));
            }
            const curSrc = await readFile(fileUris.source);
            const retrySrc = buildSourceChange(curSrc, oldKey, newKey, fileUris.source);
            if (retrySrc) retryChanges.push(retrySrc);

            const result = await applyTextFileChanges(retryChanges);
            assert.strictEqual(result.applied, 4, 'all 4 files should be renamed on retry');

            for (const locale of Object.keys(FIXTURES)) {
                assert.notStrictEqual(
                    JSON.parse(await readFile(fileUris[locale]))[newKey.split('.')[0]],
                    undefined,
                    `${locale} should have renamed key after retry`,
                );
            }
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });
});

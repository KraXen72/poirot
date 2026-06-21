const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const { buildRenameChanges } = require('../concepts/providers/renameProvider');
const { applyTextFileChanges } = require('../concepts/utils/text-edits');

// ---- Fixtures ----

const LOCALES = ['en', 'pt-PT', 'es'];
const FIXTURES = {
    en: { key_one: 'One', key_two: 'Two', key_three: 'Three', key_four: 'Four', key_five: 'Five' },
    'pt-PT': { key_one: 'Um', key_two: 'Dois', key_three: 'Três', key_four: 'Quatro', key_five: 'Cinco' },
    es: { key_one: 'Uno', key_two: 'Dos', key_three: 'Tres', key_four: 'Cuatro', key_five: 'Cinco' },
};

const INLANG_SETTINGS = {
    baseLocale: 'en',
    locales: ['en', 'pt-PT', 'es'],
    'plugin.inlang.messageFormat': {
        pathPattern: './messages/{locale}.json',
    },
};

const SOURCE_FILES = {
    'src/app.js': [
        "import * as m from './paraglide/messages.js';",
        "const header = m.key_one();",
        "const subtitle = m.key_two({ count: items.length });",
        "const body = m.key_three();",
        "const footer = m.key_four();",
        "const copyright = m.key_five({ year: 2026 });",
    ].join('\n') + '\n',
    'src/components/header.js': [
        "import * as m from '../paraglide/messages.js';",
        'export function renderHeader() {',
        "    return `<h1>${m.key_one()}</h1>`;",
        '}',
    ].join('\n') + '\n',
    'src/components/footer.js': [
        "import * as m from '../paraglide/messages.js';",
        'export function renderFooter() {',
        "    return `<footer>${m.key_five({ year: 2026 })}</footer>`;",
        '}',
    ].join('\n') + '\n',
    'src/utils/helpers.js': [
        'export function formatDate(date) {',
        "    return date.toLocaleDateString('en-US');",
        '}',
    ].join('\n') + '\n',
    'src/pages/about.js': [
        "import * as m from '../paraglide/messages.js';",
        'export function renderAbout() {',
        "    return `<p>${m.key_two()}</p>`;",
        '}',
    ].join('\n') + '\n',
};

// ---- Helpers ----

async function createFullWorkspace() {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ew-real-'));
    const messagesDir = path.join(dir, 'messages');
    const srcDir = path.join(dir, 'src');
    const componentsDir = path.join(srcDir, 'components');
    const pagesDir = path.join(srcDir, 'pages');
    const utilsDir = path.join(srcDir, 'utils');
    const inlangDir = path.join(dir, 'project.inlang');

    await fs.promises.mkdir(messagesDir, { recursive: true });
    await fs.promises.mkdir(componentsDir, { recursive: true });
    await fs.promises.mkdir(pagesDir, { recursive: true });
    await fs.promises.mkdir(utilsDir, { recursive: true });
    await fs.promises.mkdir(inlangDir, { recursive: true });

    await fs.promises.writeFile(
        path.join(inlangDir, 'settings.json'),
        JSON.stringify(INLANG_SETTINGS, null, 2) + '\n',
        'utf8',
    );

    const fileUris = {};
    for (const locale of LOCALES) {
        const fp = path.join(messagesDir, `${locale}.json`);
        await fs.promises.writeFile(fp, JSON.stringify(FIXTURES[locale], null, 2) + '\n', 'utf8');
        fileUris[locale] = vscode.Uri.file(fp);
    }

    fileUris.sources = {};
    for (const [rel, content] of Object.entries(SOURCE_FILES)) {
        const fp = path.join(dir, rel);
        await fs.promises.writeFile(fp, content, 'utf8');
        fileUris.sources[rel] = vscode.Uri.file(fp);
    }

    return { dir, fileUris };
}

async function readFile(uri) {
    return fs.promises.readFile(uri.fsPath, 'utf8');
}

/** Reads from the document buffer if the file is open (clean or dirty), else from disk. */
async function readText(uri) {
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    return doc ? doc.getText() : readFile(uri);
}

function makeDirty(document, transform) {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
    );
    edit.replace(document.uri, fullRange, transform(document.getText()));
    return vscode.workspace.applyEdit(edit);
}

// ---- Tests ----

suite('rename real-world pipeline', function () {
    this.timeout(20_000);

    test('renames a flat key using the full pipeline with all files closed', async () => {
        const { dir, fileUris } = await createFullWorkspace();

        try {
            const document = await vscode.workspace.openTextDocument(
                fileUris.sources['src/app.js'],
            );
            await vscode.window.showTextDocument(document);

            const { LocaleService } = require('../concepts/locale/service');
            const { TranslationService } = require('../concepts/translation/service');
            const localeService = new LocaleService();
            const translationService = new TranslationService();

            const changes = await buildRenameChanges(
                document,
                'key_one',
                'title',
                translationService,
                localeService,
            );

            assert.strictEqual(changes.length, 5,
                'should return changes for 3 locale files + 2 source files with key_one');

            await applyTextFileChanges(changes);

            for (const locale of LOCALES) {
                const json = JSON.parse(await readFile(fileUris[locale]));
                assert.notStrictEqual(json.title, undefined,
                    `${locale} disk should have new key "title"`);
                assert.strictEqual(json.key_one, undefined,
                    `${locale} disk should have removed old key "key_one"`);
            }

            for (const rel of Object.keys(SOURCE_FILES)) {
                const text = await readText(fileUris.sources[rel]);

                if (rel === 'src/utils/helpers.js') {
                    assert.strictEqual(text.includes('m.'), false,
                        'helpers.js with no calls should be untouched');
                    continue;
                }

                const hasOld = text.includes('m.key_one(') || text.includes('m["key_one"](');
                const hasNew = text.includes('m.title(') || text.includes('m["title"](');

                if (rel === 'src/app.js' || rel === 'src/components/header.js') {
                    assert.notStrictEqual(hasNew, false,
                        `${rel} should reference new key "title"`);
                    assert.strictEqual(hasOld, false,
                        `${rel} should not reference old key "key_one"`);
                } else {
                    assert.strictEqual(hasNew, false,
                        `${rel} should not have been renamed`);
                }
            }
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });

    test('renames a nested key using the full pipeline with all files closed', async () => {
        const { dir, fileUris } = await createFullWorkspace();

        try {
            const document = await vscode.workspace.openTextDocument(
                fileUris.sources['src/app.js'],
            );
            await vscode.window.showTextDocument(document);

            const { LocaleService } = require('../concepts/locale/service');
            const { TranslationService } = require('../concepts/translation/service');
            const localeService = new LocaleService();
            const translationService = new TranslationService();

            const changes = await buildRenameChanges(
                document,
                'key_three',
                'page.heading',
                translationService,
                localeService,
            );

            assert.strictEqual(changes.length, 4,
                'should return changes for 3 locale files + 1 source file with key_three');

            await applyTextFileChanges(changes);

            for (const locale of LOCALES) {
                const json = JSON.parse(await readFile(fileUris[locale]));
                assert.notStrictEqual(json.page, undefined,
                    `${locale} disk should have nested key parent "page"`);
                assert.strictEqual(json.page.heading, FIXTURES[locale].key_three,
                    `${locale} disk should have "page.heading" with original value`);
                assert.strictEqual(json.key_three, undefined,
                    `${locale} disk should have removed old key "key_three"`);
            }

            for (const rel of Object.keys(SOURCE_FILES)) {
                const text = await readText(fileUris.sources[rel]);
                if (rel === 'src/utils/helpers.js') continue;

                if (rel === 'src/components/header.js') {
                    assert.strictEqual(
                        text.includes('m.key_three(') || text.includes('m["key_three"]('),
                        false,
                        `${rel} should not reference old key "key_three"`);
                    continue;
                }

                if (rel === 'src/app.js') {
                    assert.notStrictEqual(text.includes('m["page.heading"]('), false,
                        `${rel} should use bracket notation for nested key`);
                    assert.strictEqual(
                        text.includes('m.key_three(') || text.includes('m["key_three"]('),
                        false, `${rel} should not reference old key`);
                }
            }
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });

    test('renames two keys sequentially using the full pipeline', async () => {
        const { dir, fileUris } = await createFullWorkspace();

        try {
            const document = await vscode.workspace.openTextDocument(
                fileUris.sources['src/app.js'],
            );
            await vscode.window.showTextDocument(document);

            const { LocaleService } = require('../concepts/locale/service');
            const { TranslationService } = require('../concepts/translation/service');
            const localeService = new LocaleService();
            const translationService = new TranslationService();

            // Rename 1: key_one → title
            const changes1 = await buildRenameChanges(
                document, 'key_one', 'title',
                translationService, localeService,
            );
            assert.strictEqual(changes1.length, 5,
                'first rename should cover 3 locale + 2 source files');
            await applyTextFileChanges(changes1);

            // Rename 2: key_three → page.heading (reading from the now-renamed buffer)
            const changes2 = await buildRenameChanges(
                document, 'key_three', 'page.heading',
                translationService, localeService,
            );
            assert.strictEqual(changes2.length, 4,
                'second rename should cover 3 locale + 1 source file');
            await applyTextFileChanges(changes2);

            for (const locale of LOCALES) {
                const json = JSON.parse(await readFile(fileUris[locale]));
                assert.notStrictEqual(json.title, undefined,
                    `${locale} should have "title" after first rename`);
                assert.notStrictEqual(json.page, undefined,
                    `${locale} should have "page" after second rename`);
                assert.strictEqual(json.key_one, undefined,
                    `${locale} should have removed "key_one"`);
                assert.strictEqual(json.key_three, undefined,
                    `${locale} should have removed "key_three"`);
                assert.strictEqual(json.key_five, FIXTURES[locale].key_five,
                    `${locale} should still have "key_five"`);
            }

            const appText = await readText(fileUris.sources['src/app.js']);
            assert.notStrictEqual(appText.includes('m.title()'), false,
                'app.js should use m.title()');
            assert.notStrictEqual(appText.includes('m["page.heading"]('), false,
                'app.js should use m["page.heading"]()');
            assert.strictEqual(appText.includes('m.key_one('), false,
                'app.js should not reference key_one');
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });

    test('throws when new key already exists in a locale file', async () => {
        const { dir, fileUris } = await createFullWorkspace();

        try {
            // Pre-populate "key_two" as the new key target in en.json
            const enPath = fileUris.en.fsPath;
            const enJson = { key_two: 'Already here', key_one: 'One', key_three: 'Three', key_four: 'Four', key_five: 'Five' };
            await fs.promises.writeFile(enPath, JSON.stringify(enJson, null, 2) + '\n', 'utf8');

            const document = await vscode.workspace.openTextDocument(
                fileUris.sources['src/app.js'],
            );
            await vscode.window.showTextDocument(document);

            const { LocaleService } = require('../concepts/locale/service');
            const { TranslationService } = require('../concepts/translation/service');
            const localeService = new LocaleService();
            const translationService = new TranslationService();

            await assert.rejects(
                () => buildRenameChanges(
                    document, 'key_one', 'key_two',
                    translationService, localeService,
                ),
                /already exists/,
            );
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });

    test('renames a flat key when a locale file is dirty', async () => {
        const { dir, fileUris } = await createFullWorkspace();

        try {
            const enDoc = await vscode.workspace.openTextDocument(fileUris.en);
            await makeDirty(enDoc, text => {
                const json = JSON.parse(text);
                json.dirty_only = 'present in buffer';
                return JSON.stringify(json, null, 2) + '\n';
            });

            const document = await vscode.workspace.openTextDocument(
                fileUris.sources['src/app.js'],
            );
            await vscode.window.showTextDocument(document);

            const { LocaleService } = require('../concepts/locale/service');
            const { TranslationService } = require('../concepts/translation/service');
            const localeService = new LocaleService();
            const translationService = new TranslationService();

            const changes = await buildRenameChanges(
                document, 'key_one', 'title',
                translationService, localeService,
            );

            assert.strictEqual(changes.length, 5,
                'should return changes for 3 locale + 2 source files');

            await applyTextFileChanges(changes);

            const enJson = JSON.parse(enDoc.getText());
            assert.notStrictEqual(enJson.title, undefined,
                'dirty en.json buffer should have new key "title"');
            assert.strictEqual(enJson.key_one, undefined,
                'dirty en.json buffer should have removed old key "key_one"');
            assert.strictEqual(enJson.dirty_only, 'present in buffer',
                'dirty en.json buffer should retain the dirty-added key');

            for (const locale of ['pt-PT', 'es']) {
                const json = JSON.parse(await readFile(fileUris[locale]));
                assert.notStrictEqual(json.title, undefined,
                    `${locale} disk should have renamed key`);
                assert.strictEqual(json.key_one, undefined,
                    `${locale} disk should have removed old key`);
            }

            for (const rel of ['src/app.js', 'src/components/header.js']) {
                const text = await readText(fileUris.sources[rel]);
                assert.notStrictEqual(
                    text.includes('m.title(') || text.includes('m["title"]('),
                    false, `${rel} should reference new key`);
            }
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });

    test('renames a flat key when the active source file is dirty', async () => {
        const { dir, fileUris } = await createFullWorkspace();

        try {
            const document = await vscode.workspace.openTextDocument(
                fileUris.sources['src/app.js'],
            );
            await vscode.window.showTextDocument(document);
            await makeDirty(document, text => text + '// dirty comment\n');

            const { LocaleService } = require('../concepts/locale/service');
            const { TranslationService } = require('../concepts/translation/service');
            const localeService = new LocaleService();
            const translationService = new TranslationService();

            const changes = await buildRenameChanges(
                document, 'key_one', 'title',
                translationService, localeService,
            );

            assert.strictEqual(changes.length, 5,
                'should return changes for 3 locale + 2 source files');

            await applyTextFileChanges(changes);

            const text = document.getText();
            assert.notStrictEqual(text.includes('m.title('), false,
                'dirty source buffer should have renamed call');
            assert.strictEqual(text.includes('m.key_one('), false,
                'dirty source buffer should not have old key');
            assert.notStrictEqual(text.includes('// dirty comment'), false,
                'dirty source buffer should retain dirty content');

            for (const locale of LOCALES) {
                const json = JSON.parse(await readFile(fileUris[locale]));
                assert.notStrictEqual(json.title, undefined,
                    `${locale} should have renamed key`);
                assert.strictEqual(json.key_one, undefined,
                    `${locale} should have removed old key`);
            }
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });

    test('throws when new key already exists in a dirty locale file', async () => {
        const { dir, fileUris } = await createFullWorkspace();

        try {
            const enDoc = await vscode.workspace.openTextDocument(fileUris.en);
            await makeDirty(enDoc, text => {
                const json = JSON.parse(text);
                json.title = 'Already in dirty buffer';
                return JSON.stringify(json, null, 2) + '\n';
            });

            const document = await vscode.workspace.openTextDocument(
                fileUris.sources['src/app.js'],
            );
            await vscode.window.showTextDocument(document);

            const { LocaleService } = require('../concepts/locale/service');
            const { TranslationService } = require('../concepts/translation/service');
            const localeService = new LocaleService();
            const translationService = new TranslationService();

            await assert.rejects(
                () => buildRenameChanges(
                    document, 'key_one', 'title',
                    translationService, localeService,
                ),
                /already exists/,
            );

            assert.strictEqual(
                JSON.parse(enDoc.getText()).title,
                'Already in dirty buffer',
                'dirty buffer should not have changed after rejected rename',
            );
            for (const locale of ['pt-PT', 'es']) {
                assert.deepStrictEqual(
                    JSON.parse(await readFile(fileUris[locale])),
                    FIXTURES[locale],
                    `${locale} should be untouched after rejected rename`,
                );
            }
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });
});

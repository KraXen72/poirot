const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

async function withPatchedWorkspaceMethod(name, replacement, run) {
    const original = vscode.workspace[name];
    vscode.workspace[name] = replacement;
    try {
        return await run();
    } finally {
        vscode.workspace[name] = original;
    }
}

async function makeTempFile(content, extension = '.txt') {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'elementary-watson-'));
    const filePath = path.join(dir, `file${extension}`);
    await fs.promises.writeFile(filePath, content, 'utf8');
    return vscode.Uri.file(filePath);
}

function fullRange(document) {
    return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

suite('ExtensionActivator rename refresh suppression', () => {
    /** @returns {import('../concepts/extension/activator').ExtensionActivator} */
    function makeActivator() {
        const { ExtensionActivator } = require('../concepts/extension/activator');
        return new ExtensionActivator();
    }

    test('suppresses known rename URIs', () => {
        const a = makeActivator();
        a.beginRenameRefreshSuppression(['file:///a.json', 'file:///b.ts']);

        assert.strictEqual(a.shouldSuppressRenameRefresh('file:///a.json'), true);
        assert.strictEqual(a.shouldSuppressRenameRefresh('file:///b.ts'), true);
        assert.strictEqual(a.shouldSuppressRenameRefresh('file:///c.ts'), true, 'all refreshes are suppressed during apply');
    });

    test('late rename URI events are skipped once after apply', () => {
        const a = makeActivator();
        a.beginRenameRefreshSuppression(['file:///a.json']);
        a._isApplyingRename = false;

        assert.strictEqual(a.shouldSuppressRenameRefresh('file:///a.json'), true);
        assert.strictEqual(a.shouldSuppressRenameRefresh('file:///a.json'), false);
    });

    test('beginRenameRefreshSuppression clears pending debounced refreshes for changed URIs', () => {
        const a = makeActivator();
        const timeout = setTimeout(() => {}, 1000);
        a.documentUpdateTimeouts.set('file:///a.ts', timeout);

        a.beginRenameRefreshSuppression(['file:///a.ts']);

        assert.strictEqual(a.documentUpdateTimeouts.has('file:///a.ts'), false);
    });
});

suite('ExtensionActivator activation', () => {
    /** @returns {import('../concepts/extension/activator').ExtensionActivator} */
    function makeActivator() {
        const { ExtensionActivator } = require('../concepts/extension/activator');
        return new ExtensionActivator();
    }

    test('registers contributed command handlers during activation', () => {
        const a = makeActivator();
        const calls = [];

        a.registerSidebar = () => calls.push('registerSidebar');
        a.sidebarTreeProvider.setTreeView = () => {};
        a.registerChangeLocaleCommand = () => calls.push('registerChangeLocaleCommand');
        a.registerInspectTranslationCommand = () => calls.push('registerInspectTranslationCommand');
        a.registerExtractTextCommand = () => calls.push('registerExtractTextCommand');
        a.registerRenameKeyCommand = () => calls.push('registerRenameKeyCommand');
        a.registerDeleteKeyCommands = () => calls.push('registerDeleteKeyCommands');
        a.registerSidebarCommands = () => calls.push('registerSidebarCommands');
        a.registerCopyTranslationCommand = () => calls.push('registerCopyTranslationCommand');
        a.registerTranslationLabelClickCommand = () => calls.push('registerTranslationLabelClickCommand');
        a.registerCodeLensProvider = () => calls.push('registerCodeLensProvider');
        a.setupEventListeners = () => calls.push('setupEventListeners');
        a.setupTranslationFileWatchers = () => calls.push('setupTranslationFileWatchers');
        a.processActiveEditor = () => calls.push('processActiveEditor');
        a.editorService.getDecorator = () => ({ getDecorationType: () => null });

        a.activate({ subscriptions: [] });

        assert.ok(calls.includes('registerInspectTranslationCommand'));
        assert.ok(calls.includes('registerRenameKeyCommand'));
        assert.ok(calls.includes('registerDeleteKeyCommands'));
    });
});

suite('validateRenameKey', () => {
    const { validateRenameKey } = require('../concepts/providers/renameProvider');

    test('accepts valid flat keys', () => {
        assert.strictEqual(validateRenameKey('hello_world'), null);
        assert.strictEqual(validateRenameKey('my_key_123'), null);
        assert.strictEqual(validateRenameKey('$valid'), null);
    });

    test('accepts valid nested keys', () => {
        assert.strictEqual(validateRenameKey('login.inputs.email'), null);
        assert.strictEqual(validateRenameKey('a.b.c'), null);
    });

    test('rejects keys with spaces', () => {
        assert.ok(typeof validateRenameKey('hello world') === 'string');
    });

    test('rejects keys starting with a digit', () => {
        assert.ok(typeof validateRenameKey('1invalid') === 'string');
    });

    test('rejects keys with hyphens', () => {
        assert.ok(typeof validateRenameKey('bad-key') === 'string');
    });

    test('rejects empty string', () => {
        assert.ok(typeof validateRenameKey('') === 'string');
    });
});

suite('renameProvider source edits', () => {
    const {
        applySourceReplacements,
        buildSourceRenameEdits,
    } = require('../concepts/providers/renameProvider');

    test('renames flat calls with range edits', () => {
        const text = 'const a = m.title();';
        const edits = buildSourceRenameEdits(text, [
            { methodName: 'title', start: 10, end: 19, keyType: 'flat' },
        ], 'heading');

        assert.deepStrictEqual(edits, [{ start: 12, end: 17, replacement: 'heading' }]);
        assert.strictEqual(applySourceReplacements(text, edits), 'const a = m.heading();');
    });

    test('renames flat calls to nested bracket calls', () => {
        const text = 'const a = m.title();';
        const edits = buildSourceRenameEdits(text, [
            { methodName: 'title', start: 10, end: 19, keyType: 'flat' },
        ], 'page.title');

        assert.deepStrictEqual(edits, [{ start: 11, end: 17, replacement: '["page.title"]' }]);
        assert.strictEqual(applySourceReplacements(text, edits), 'const a = m["page.title"]();');
    });

    test('renames quoted nested calls without changing quote style', () => {
        const text = "const a = m['page.title']();";
        const edits = buildSourceRenameEdits(text, [
            { methodName: 'page.title', start: 10, end: 27, keyType: 'nested' },
        ], 'page.heading');

        assert.deepStrictEqual(edits, [{ start: 13, end: 23, replacement: 'page.heading' }]);
        assert.strictEqual(applySourceReplacements(text, edits), "const a = m['page.heading']();");
    });
});

suite('human-key generator', () => {
    const { generateHumanKey } = require('../concepts/utils/human-key');
    const wordlists = require('../concepts/utils/human-key-wordlists.json');
    const adjectives = new Set(wordlists.adjectives);
    const firstWords = new Set([...wordlists.adjectives, ...wordlists.colors]);
    const nouns = new Set(wordlists.nouns);
    const verbs = new Set(wordlists.verbs);

    test('generates four lowercase underscore-separated words', () => {
        for (let i = 0; i < 25; i++) {
            assert.match(generateHumanKey(), /^[a-z]+_[a-z]+_[a-z]+_[a-z]+$/);
        }
    });

    test('uses words from the bundled wordlists', () => {
        for (let i = 0; i < 25; i++) {
            const [first, second, noun, verb] = generateHumanKey().split('_');

            assert.ok(firstWords.has(first), `${first} should be an adjective or color`);
            assert.ok(adjectives.has(second), `${second} should be an adjective`);
            assert.ok(nouns.has(noun), `${noun} should be a noun`);
            assert.ok(verbs.has(verb), `${verb} should be a verb`);
        }
    });

    test('does not repeat the adjective slots in one key', () => {
        for (let i = 0; i < 25; i++) {
            const [first, second] = generateHumanKey().split('_');

            assert.notStrictEqual(first, second);
        }
    });

    test('has enough source words for a low-collision id space', () => {
        assert.ok(wordlists.adjectives.length > 500);
        assert.ok(wordlists.colors.length > 10);
        assert.ok(wordlists.nouns.length > 1000);
        assert.ok(wordlists.verbs.length > 500);
    });
});

suite('text-edits transaction helper', () => {
    const { applyTextFileChanges } = require('../concepts/utils/text-edits');

    test('direct-write-only success does not call workspace.applyEdit', async () => {
        const uri = await makeTempFile('old');
        let applyEditCalls = 0;

        await withPatchedWorkspaceMethod('applyEdit', async () => {
            applyEditCalls++;
            return true;
        }, async () => {
            await applyTextFileChanges([{ uri, oldText: 'old', newText: 'new', reason: 'test file' }]);
        });

        assert.strictEqual(applyEditCalls, 0);
        assert.strictEqual(await fs.promises.readFile(uri.fsPath, 'utf8'), 'new');
    });

    test('dirty files use one WorkspaceEdit per changed file', async () => {
        const uri = await makeTempFile('old');
        const document = await vscode.workspace.openTextDocument(uri);
        const makeDirty = new vscode.WorkspaceEdit();
        makeDirty.replace(uri, fullRange(document), 'dirty old');
        assert.strictEqual(await vscode.workspace.applyEdit(makeDirty), true);

        let applyEditCalls = 0;
        const originalApplyEdit = vscode.workspace.applyEdit;
        await withPatchedWorkspaceMethod('applyEdit', async edit => {
            applyEditCalls++;
            return originalApplyEdit.call(vscode.workspace, edit);
        }, async () => {
            await applyTextFileChanges([{ uri, oldText: 'dirty old', newText: 'dirty new', reason: 'dirty file' }]);
        });

        assert.strictEqual(applyEditCalls, 1);
        assert.strictEqual(document.getText(), 'dirty new');
        assert.strictEqual(await fs.promises.readFile(uri.fsPath, 'utf8'), 'old');

        const cleanup = new vscode.WorkspaceEdit();
        cleanup.replace(uri, fullRange(document), 'old');
        assert.strictEqual(await vscode.workspace.applyEdit(cleanup), true);
        assert.strictEqual(await document.save(), true);
    });

    test('open files can use range edits without writing to disk', async () => {
        const uri = await makeTempFile('const a = m.title();', '.js');
        const document = await vscode.workspace.openTextDocument(uri);

        let applyEditCalls = 0;
        const originalApplyEdit = vscode.workspace.applyEdit;
        await withPatchedWorkspaceMethod('applyEdit', async edit => {
            applyEditCalls++;
            return originalApplyEdit.call(vscode.workspace, edit);
        }, async () => {
            await applyTextFileChanges([{
                uri,
                oldText: 'const a = m.title();',
                newText: 'const a = m.heading();',
                edits: [{ start: 12, end: 17, replacement: 'heading' }],
                reason: 'source range edit',
            }]);
        });

        assert.strictEqual(applyEditCalls, 1);
        assert.strictEqual(document.getText(), 'const a = m.heading();');
        assert.strictEqual(await fs.promises.readFile(uri.fsPath, 'utf8'), 'const a = m.title();');

        const cleanup = new vscode.WorkspaceEdit();
        cleanup.replace(uri, fullRange(document), 'const a = m.title();');
        assert.strictEqual(await vscode.workspace.applyEdit(cleanup), true);
        assert.strictEqual(await document.save(), true);
    });

    test('forward direct-write failure rolls back previous writes', async () => {
        const first = await makeTempFile('first old');
        const second = await makeTempFile('actual current');

        await assert.rejects(
            () => applyTextFileChanges([
                { uri: first, oldText: 'first old', newText: 'first new', reason: 'first' },
                { uri: second, oldText: 'planned old', newText: 'second new', reason: 'second' },
            ]),
            /rolled back/,
        );

        assert.strictEqual(await fs.promises.readFile(first.fsPath, 'utf8'), 'first old');
        assert.strictEqual(await fs.promises.readFile(second.fsPath, 'utf8'), 'actual current');
    });

    test('unchanged replacements are skipped', async () => {
        const uri = await makeTempFile('same');
        let writeCalls = 0;
        const originalWriteFile = vscode.workspace.fs.writeFile;
        vscode.workspace.fs.writeFile = async (...args) => {
            writeCalls++;
            return originalWriteFile.apply(vscode.workspace.fs, args);
        };

        try {
            const result = await applyTextFileChanges([{ uri, oldText: 'same', newText: 'same', reason: 'same' }]);
            assert.deepStrictEqual(result, { applied: 0, skipped: 1 });
            assert.strictEqual(writeCalls, 0);
        } finally {
            vscode.workspace.fs.writeFile = originalWriteFile;
        }
    });
});

suite('deleteProvider helpers', () => {
    const {
        applyCallReplacements,
        buildDeleteChanges,
        buildUsageSearchRegex,
        findBalancedCallEnd,
        getLocalePathsByLocale,
    } = require('../concepts/providers/deleteProvider');

    test('replaces flat and bracket notation calls with a string literal', () => {
        const text = 'const a = m.title(); const b = m["nested.key"]({ count });';
        const calls = [
            { methodName: 'title', start: 10, end: 19, keyType: 'flat' },
            { methodName: 'nested.key', start: 31, end: 57, keyType: 'nested' },
        ];

        assert.strictEqual(
            applyCallReplacements(text, calls, '"Title"'),
            'const a = "Title"; const b = "Title";',
        );
    });

    test('uses balanced call ranges when arguments contain nested parentheses', () => {
        const text = 'const greeting = m.greeting({ name: format(user) });';
        const call = { methodName: 'greeting', start: 17, end: 48, keyType: 'flat' };

        assert.strictEqual(findBalancedCallEnd(text, call), 51);
        assert.strictEqual(
            applyCallReplacements(text, [{ ...call, end: findBalancedCallEnd(text, call) }], '"Hello"'),
            'const greeting = "Hello";',
        );
    });

    test('builds a search regex for supported flat and bracket usage forms', () => {
        const regex = buildUsageSearchRegex('my_key');
        assert.match('{m.my_key()}', new RegExp(regex, 'u'));
        assert.match('m.my_key({ count })', new RegExp(regex, 'u'));
        assert.match('{m["my_key"]()}', new RegExp(regex, 'u'));
        assert.match("{m['my_key']()}", new RegExp(regex, 'u'));
        assert.match('{m[`my_key`]()}', new RegExp(regex, 'u'));
        assert.doesNotMatch('{m.my_key_extra()}', new RegExp(regex, 'u'));
    });

    test('builds a bracket-only search regex for nested keys', () => {
        const regex = buildUsageSearchRegex('nested.key');
        assert.match('m["nested.key"]()', new RegExp(regex, 'u'));
        assert.match("m['nested.key']()", new RegExp(regex, 'u'));
        assert.match('m[`nested.key`]()', new RegExp(regex, 'u'));
        assert.doesNotMatch('m.nested.key()', new RegExp(regex, 'u'));
    });

    test('preserves locale names for directory-based locale path patterns', async () => {
        const localeService = {
            getAvailableLocales: async () => ['en', 'es'],
            resolveTranslationPathAsync: async (root, locale) => `${root}/messages/${locale}/messages.json`,
        };

        assert.deepStrictEqual(
            await getLocalePathsByLocale('/workspace', localeService),
            [
                { locale: 'en', filePath: '/workspace/messages/en/messages.json' },
                { locale: 'es', filePath: '/workspace/messages/es/messages.json' },
            ],
        );
    });

    test('delete planning returns changes without writing', () => {
        const uri = vscode.Uri.file('/workspace/messages/en.json');
        const changes = buildDeleteChanges({
            key: 'title',
            inlineValue: 'Title',
            localeFiles: [{ uri, raw: '{\n  "title": "Title",\n  "keep": "Keep"\n}', json: { title: 'Title', keep: 'Keep' } }],
            sourceFiles: [{ uri: vscode.Uri.file('/workspace/src/app.js'), raw: 'const title = m.title();', calls: [{ start: 14, end: 23 }] }],
        });

        assert.strictEqual(changes.length, 2);
        assert.deepStrictEqual(
            changes.map(change => ({ uri: change.uri.fsPath, oldText: change.oldText, newText: change.newText })),
            [
                { uri: '/workspace/src/app.js', oldText: 'const title = m.title();', newText: 'const title = "Title";' },
                { uri: '/workspace/messages/en.json', oldText: '{\n  "title": "Title",\n  "keep": "Keep"\n}', newText: '{\n  "keep": "Keep"\n}' },
            ],
        );
    });
});

suite('json-utils delete helpers', () => {
    const { deleteJsonKey, flattenJsonKeys } = require('../concepts/utils/json-utils');

    test('removes a nested key without affecting siblings', () => {
        const input = { title: 'Title', nested: { keep: 'Keep', remove: 'Remove' } };
        assert.deepStrictEqual(
            deleteJsonKey(input, 'nested.remove'),
            { title: 'Title', nested: { keep: 'Keep' } },
        );
        assert.deepStrictEqual(input, { title: 'Title', nested: { keep: 'Keep', remove: 'Remove' } });
    });

    test('flattens leaf keys from nested locale JSON', () => {
        assert.deepStrictEqual(
            flattenJsonKeys({ title: 'Title', nested: { body: 'Body' }, variants: [] }).sort(),
            ['nested.body', 'title', 'variants'],
        );
    });
});

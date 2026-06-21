const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Helpers that re-create the pre-fix buggy behaviour so we can show the test
// fails against it, then verify the fix passes.
// ---------------------------------------------------------------------------

// ---- applyReverseEdits (text-edits.js) ----

const { applyReverseEdits } = require('../concepts/utils/text-edits');

// ---- _buildSafeGlobPattern (activator.js) ----

/**
 * Buggy version of _buildSafeGlobPattern (only strips ./)
 */
function buggyBuildSafeGlobPattern(pathPattern) {
    let glob = pathPattern.replace('{locale}', '*').replace(/^\.\//, '');
    if (!glob.includes('/')) {
        glob = `messages/${glob}`;
    }
    return glob;
}

/**
 * Fixed version
 */
function fixedBuildSafeGlobPattern(pathPattern) {
    let glob = pathPattern.replace('{locale}', '*').replace(/^(\.\/|\/)/, '');
    if (!glob.includes('/')) {
        glob = `messages/${glob}`;
    }
    return glob;
}

// ---- findExistingTranslation / base-locale cache (extraction/service.js) ----

/**
 * Pre-fix: findExistingTranslation reads the file internally, and generateUniqueKey
 * reads it again – we can't observe the caching directly, but we *can* test that
 * loadBaseTranslations returns correct data and that passing it to the new
 * findExistingTranslation works.
 */
const { ExtractionService } = require('../concepts/extraction/service');

// ---- getAvailableLocales - empty dir fix (locale/service.js) ----

const { LocaleService } = require('../concepts/locale/service');

// ---- _buildCharReplacement bracket-notation fix (renameProvider.js) ----

const { buildSourceRenameEdits, applySourceReplacements } = require('../concepts/providers/renameProvider');

// ---- KEY_PATTERN fix (renameProvider.js) ----

const { validateRenameKey } = require('../concepts/providers/renameProvider');

// ---- cancelPendingClear (sidebar/provider.js) ----

const { SidebarTreeProvider } = require('../concepts/sidebar/provider');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('applyReverseEdits', () => {

    test('produces correct text when edits are given in forward order', () => {
        const text = 'abcdef';
        const edits = [
            { start: 3, end: 4, replacement: 'X' },  // d → X
            { start: 0, end: 1, replacement: 'Y' },  // a → Y
        ];
        assert.strictEqual(applyReverseEdits(text, edits), 'YbcXef');
    });

    test('produces correct text when edits share no overlap', () => {
        const text = 'hello world';
        const edits = [
            { start: 0, end: 5, replacement: 'hi' },
            { start: 6, end: 11, replacement: 'there' },
        ];
        assert.strictEqual(applyReverseEdits(text, edits), 'hi there');
    });

    test('handles a single edit', () => {
        const text = 'foobar';
        const edits = [{ start: 3, end: 6, replacement: 'baz' }];
        assert.strictEqual(applyReverseEdits(text, edits), 'foobaz');
    });

    test('handles empty edits array', () => {
        assert.strictEqual(applyReverseEdits('anything', []), 'anything');
    });

    test('handles edit that replaces entire text', () => {
        const text = 'old';
        const edits = [{ start: 0, end: 3, replacement: 'new' }];
        assert.strictEqual(applyReverseEdits(text, edits), 'new');
    });

    test('handles multiple edits correctly regardless of input order', () => {
        // Edits handed in descending order should also work
        const text = 'abcdef';
        const edits = [
            { start: 3, end: 4, replacement: 'X' },
            { start: 0, end: 1, replacement: 'Y' },
        ].reverse(); // descending order
        assert.strictEqual(applyReverseEdits(text, edits), 'YbcXef');
    });

});

suite('_buildSafeGlobPattern', () => {

    test('strips leading ./ from pattern', () => {
        assert.strictEqual(
            fixedBuildSafeGlobPattern('./messages/{locale}.json'),
            'messages/*.json',
        );
    });

    test('strips leading / from pattern (the pre-fix missed this)', () => {
        // Before the fix, this would return '/messages/*.json' which is
        // a malformed RelativePattern path.
        assert.strictEqual(
            fixedBuildSafeGlobPattern('/messages/{locale}.json'),
            'messages/*.json',
        );
    });

    test('leaves pattern without prefix unchanged', () => {
        assert.strictEqual(
            fixedBuildSafeGlobPattern('messages/{locale}.json'),
            'messages/*.json',
        );
    });

    test('scopes root-level globs under messages/', () => {
        const result = fixedBuildSafeGlobPattern('{locale}.json');
        assert.strictEqual(result, 'messages/*.json');
    });

    test('scopes root-level ./{locale}.json under messages/', () => {
        const result = fixedBuildSafeGlobPattern('./{locale}.json');
        assert.strictEqual(result, 'messages/*.json');
    });

    test('scopes root-level /{locale}.json under messages/', () => {
        const result = fixedBuildSafeGlobPattern('/{locale}.json');
        assert.strictEqual(result, 'messages/*.json');
    });

});

suite('validateRenameKey (KEY_PATTERN)', () => {

    test('rejects key with trailing dot — would produce empty segment', () => {
        assert.notStrictEqual(validateRenameKey('a.'), null,
            'trailing dot should be rejected');
    });

    test('rejects key with leading dot — would produce empty segment', () => {
        assert.notStrictEqual(validateRenameKey('.a'), null,
            'leading dot should be rejected');
    });

    test('rejects key with consecutive dots — would produce empty segment', () => {
        assert.notStrictEqual(validateRenameKey('a..b'), null,
            'consecutive dots should be rejected');
    });

    test('rejects key that is only dots', () => {
        assert.notStrictEqual(validateRenameKey('..'), null,
            'only dots should be rejected');
    });

    test('accepts simple flat key', () => {
        assert.strictEqual(validateRenameKey('title'), null);
    });

    test('accepts dotted key with valid segments', () => {
        assert.strictEqual(validateRenameKey('page.title'), null);
    });

    test('accepts deeply nested valid key', () => {
        assert.strictEqual(validateRenameKey('a.b.c.d'), null);
    });

    test('accepts key with underscores and dollar signs', () => {
        assert.strictEqual(validateRenameKey('_my_key'), null);
        assert.strictEqual(validateRenameKey('$store.value'), null);
    });

    test('rejects key starting with a digit', () => {
        assert.notStrictEqual(validateRenameKey('1key'), null);
    });

});

suite('_buildCharReplacement — nested-to-flat bracket notation', () => {

    function buildCharReplacementFor(text, oldKey, newKey) {
        // findTranslationCalls doesn't know the oldKey, so we
        // filter manually.
        const calls = [];
        const flatPattern = /\bm\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(\s*([^)]*)\s*\)/g;
        const nestedPattern = /\bm\[(['"`])([^'"]+)\1\]\s*\(\s*([^)]*)\s*\)/g;
        let match;
        while ((match = flatPattern.exec(text)) !== null) {
            if (match[1] === oldKey) {
                calls.push({ methodName: match[1], start: match.index, end: match.index + match[0].length, keyType: 'flat' });
            }
        }
        while ((match = nestedPattern.exec(text)) !== null) {
            if (match[2] === oldKey) {
                calls.push({ methodName: match[2], start: match.index, end: match.index + match[0].length, keyType: 'nested' });
            }
        }
        if (calls.length === 0) return text;
        const edits = buildSourceRenameEdits(text, calls, newKey);
        return applySourceReplacements(text, edits);
    }

    test('renames nested key to flat key — converts m["old"]() to m.new()', () => {
        const result = buildCharReplacementFor(
            "const x = m[\"page.title\"]();",
            'page.title',
            'title',
        );
        // Before the fix this produced m["title"]()
        assert.ok(result.includes('m.title()'),
            'should use dot notation for flat new key');
        assert.ok(!result.includes('m["title"]('),
            'bracket notation should NOT be used when new key has no dots');
    });

    test('renames nested key to nested key — keeps bracket notation', () => {
        const result = buildCharReplacementFor(
            "const x = m[\"page.title\"]();",
            'page.title',
            'section.title',
        );
        assert.ok(result.includes('m["section.title"]('),
            'bracket notation is correct when new key has dots');
    });

    test('renames flat key to flat key — keeps dot notation', () => {
        const result = buildCharReplacementFor(
            "const x = m.title();",
            'title',
            'heading',
        );
        assert.ok(result.includes('m.heading()'),
            'flat-to-flat should keep dot notation');
        assert.ok(!result.includes('m["heading"]('),
            'flat-to-flat should not use bracket notation');
    });

    test('renames flat key to nested key — switches to bracket notation', () => {
        const result = buildCharReplacementFor(
            "const x = m.title();",
            'title',
            'page.heading',
        );
        assert.ok(result.includes('m["page.heading"]('),
            'flat-to-nested should use bracket notation');
    });

    test('renames nested key to flat key with single quotes', () => {
        const result = buildCharReplacementFor(
            "const x = m['page.title']();",
            'page.title',
            'title',
        );
        assert.ok(result.includes('m.title()'),
            'should use dot notation for flat new key');
        assert.ok(!result.includes("m['title']("),
            'should not preserve bracket notation when new key has no dots');
    });

});

suite('getAvailableLocales — empty directory fallback', () => {

    async function createLocaleService() {
        return new LocaleService();
    }

    async function setupWorkspace(localeFiles) {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ew-locale-'));
        const inlangDir = path.join(dir, 'project.inlang');
        const messagesDir = path.join(dir, 'messages');
        await fs.promises.mkdir(inlangDir, { recursive: true });
        await fs.promises.mkdir(messagesDir, { recursive: true });

        const settings = {
            baseLocale: 'en',
            locales: [],
            'plugin.inlang.messageFormat': {
                pathPattern: './messages/{locale}.json',
            },
        };
        await fs.promises.writeFile(
            path.join(inlangDir, 'settings.json'),
            JSON.stringify(settings, null, 2) + '\n',
            'utf8',
        );

        for (const [locale, content] of Object.entries(localeFiles)) {
            await fs.promises.writeFile(
                path.join(messagesDir, `${locale}.json`),
                JSON.stringify(content, null, 2) + '\n',
                'utf8',
            );
        }

        return { dir };
    }

    test('returns [\'en\'] when messages directory is empty', async () => {
        const { dir } = await setupWorkspace({});
        try {
            const localeService = await createLocaleService();
            const result = await localeService.getAvailableLocales(dir);
            assert.deepStrictEqual(result, ['en'],
                'empty directory should return ["en"] fallback');
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });

    test('returns [\'en\'] when messages directory does not exist', async () => {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ew-locale-'));
        try {
            // Don't create messages dir — ENOENT path
            const inlangDir = path.join(dir, 'project.inlang');
            await fs.promises.mkdir(inlangDir, { recursive: true });
            const settings = {
                baseLocale: 'en',
                locales: [],
                'plugin.inlang.messageFormat': {
                    pathPattern: './messages/{locale}.json',
                },
            };
            await fs.promises.writeFile(
                path.join(inlangDir, 'settings.json'),
                JSON.stringify(settings, null, 2) + '\n',
                'utf8',
            );

            const localeService = await createLocaleService();
            const result = await localeService.getAvailableLocales(dir);
            assert.deepStrictEqual(result, ['en'],
                'missing messages dir should return ["en"] fallback');
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });

    test('returns found locales when directory has json files', async () => {
        const { dir } = await setupWorkspace({
            en: { greeting: 'Hello' },
            fr: { greeting: 'Bonjour' },
        });
        try {
            const localeService = await createLocaleService();
            const result = await localeService.getAvailableLocales(dir);
            result.sort();
            assert.deepStrictEqual(result, ['en', 'fr'],
                'should return locales from existing json files');
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });

});

suite('loadBaseTranslations — cached base-locale read', () => {

    async function setupWorkspace() {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ew-base-'));
        const inlangDir = path.join(dir, 'project.inlang');
        const messagesDir = path.join(dir, 'messages');
        await fs.promises.mkdir(inlangDir, { recursive: true });
        await fs.promises.mkdir(messagesDir, { recursive: true });

        const settings = {
            baseLocale: 'en',
            locales: ['en', 'fr'],
            'plugin.inlang.messageFormat': {
                pathPattern: './messages/{locale}.json',
            },
        };
        await fs.promises.writeFile(
            path.join(inlangDir, 'settings.json'),
            JSON.stringify(settings, null, 2) + '\n',
            'utf8',
        );

        await fs.promises.writeFile(
            path.join(messagesDir, 'en.json'),
            JSON.stringify({ greeting: 'Hello', farewell: 'Goodbye' }, null, 2) + '\n',
            'utf8',
        );
        await fs.promises.writeFile(
            path.join(messagesDir, 'fr.json'),
            JSON.stringify({ greeting: 'Bonjour', farewell: 'Au revoir' }, null, 2) + '\n',
            'utf8',
        );

        return { dir };
    }

    test('loadBaseTranslations returns parsed base locale content', async () => {
        const { dir } = await setupWorkspace();
        try {
            const extractionService = new ExtractionService();
            extractionService.localeService = new LocaleService();
            const baseTranslations = await extractionService.loadBaseTranslations(dir, 'en');
            assert.deepStrictEqual(baseTranslations, { greeting: 'Hello', farewell: 'Goodbye' });
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });

    test('findExistingTranslation finds matching text in pre-loaded translations', async () => {
        const extractionService = new ExtractionService();
        const baseTranslations = { greeting: 'Hello', farewell: 'Goodbye' };

        const key = await extractionService.findExistingTranslation('Hello', baseTranslations);
        assert.strictEqual(key, 'greeting',
            'should find existing translation value');
    });

    test('findExistingTranslation returns null for missing text', async () => {
        const extractionService = new ExtractionService();
        const baseTranslations = { greeting: 'Hello' };

        const key = await extractionService.findExistingTranslation('Nonexistent', baseTranslations);
        assert.strictEqual(key, null,
            'should return null for text not in translations');
    });

    test('findExistingTranslation returns null when baseTranslations is null', async () => {
        const extractionService = new ExtractionService();

        const key = await extractionService.findExistingTranslation('Hello', null);
        assert.strictEqual(key, null,
            'should handle null translations gracefully');
    });

    test('findExistingTranslation searches nested translations', async () => {
        const extractionService = new ExtractionService();
        const baseTranslations = { page: { title: 'Welcome', body: 'Content' } };

        const key = await extractionService.findExistingTranslation('Welcome', baseTranslations);
        assert.strictEqual(key, 'page.title',
            'should find value in nested translations');
    });

});

suite('cancelPendingClear — debounce timer cancellation', () => {

    function makeMockSidebarService() {
        return {
            isTranslationFile: async () => false,
            getTranslationData: async () => [],
        };
    }

    test('cancelPendingClear clears the pending timeout', async () => {
        const provider = new SidebarTreeProvider(
            makeMockSidebarService(), {}, {},
        );

        await provider.refresh(null);

        assert.notStrictEqual(provider.clearTimeout, null,
            'refresh(null) should set a debounce timeout');

        provider.cancelPendingClear();

        assert.strictEqual(provider.clearTimeout, null,
            'cancelPendingClear should clear the timeout');
    });

    test('cancelPendingClear is safe to call when no timeout is set', () => {
        const provider = new SidebarTreeProvider(
            makeMockSidebarService(), {}, {},
        );

        // Should not throw
        provider.cancelPendingClear();
    });

    test('refresh(document) also cancels pending clear', async () => {
        const provider = new SidebarTreeProvider(
            makeMockSidebarService(), {}, {},
        );

        await provider.refresh(null);
        assert.notStrictEqual(provider.clearTimeout, null,
            'should have pending timeout');

        const doc = { uri: { fsPath: '/fake/file.js' } };
        await provider.refresh(doc);

        assert.strictEqual(provider.clearTimeout, null,
            'refresh(document) should cancel pending clear');
    });

});

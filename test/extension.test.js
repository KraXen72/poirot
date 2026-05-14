const mock = require('mock-require');

// Stub the entire vscode module before any code tries to require it
const vscodeStub = {
    window: {
        createTextEditorDecorationType: () => ({ dispose() {} }),
    },
    EventEmitter: class {
        constructor() { this.event = () => {}; }
        fire() {}
        dispose() {}
    },
    DecorationRangeBehavior: { ClosedClosed: 0 },
    workspace: {
        getConfiguration: () => ({ get: () => undefined }),
    },
    commands: {
        executeCommand: async () => {},
    },
};

mock('vscode', vscodeStub);

const assert = require('assert');

suite('ExtensionActivator rename tracking', () => {
    // We test the pending-rename state machine in isolation,
    // without needing a real VS Code window.

    /** @returns {import('../concepts/extension/activator').ExtensionActivator} */
    function makeActivator() {
        // Stub out every vscode dependency so we can run without the host.
        const { ExtensionActivator } = require('../concepts/extension/activator');
        return new ExtensionActivator();
    }

    test('beginRename adds URIs to pending set', () => {
        const a = makeActivator();
        a.beginRename(['file:///a.json', 'file:///b.ts']);
        assert.ok(a._isPendingRename('file:///a.json'));
        assert.ok(a._isPendingRename('file:///b.ts'));
        assert.ok(!a._isPendingRename('file:///c.ts'));
    });

    test('acknowledging all URIs empties the pending set', async () => {
        const a = makeActivator();
        // Prevent the real _postRenameRefresh from trying to call vscode APIs.
        a._postRenameRefresh = async () => {};

        a.beginRename(['file:///a.json', 'file:///b.ts']);
        await a._acknowledgeRenameUri('file:///a.json');
        assert.ok(a._isPendingRename('file:///b.ts'), 'b.ts still pending');
        assert.ok(!a._isPendingRename('file:///a.json'), 'a.json removed');

        await a._acknowledgeRenameUri('file:///b.ts');
        assert.strictEqual(a._pendingRenameUris.size, 0, 'set empty after all acknowledged');
    });

    test('_postRenameRefresh is called exactly once after all URIs acknowledged', async () => {
        const a = makeActivator();
        let callCount = 0;
        a._postRenameRefresh = async () => { callCount++; };

        a.beginRename(['file:///x.json', 'file:///y.json']);
        await a._acknowledgeRenameUri('file:///x.json');
        assert.strictEqual(callCount, 0, 'not called yet');
        await a._acknowledgeRenameUri('file:///y.json');
        assert.strictEqual(callCount, 1, 'called exactly once');
    });

    test('acknowledging an unknown URI is a no-op', async () => {
        const a = makeActivator();
        let callCount = 0;
        a._postRenameRefresh = async () => { callCount++; };

        a.beginRename(['file:///a.json']);
        await a._acknowledgeRenameUri('file:///not-in-set.json');
        assert.strictEqual(a._pendingRenameUris.size, 1, 'still one pending');
        assert.strictEqual(callCount, 0);
    });

    test('second rename works after first completes', async () => {
        const a = makeActivator();
        const calls = [];
        a._postRenameRefresh = async () => { calls.push(Date.now()); };

        // First rename
        a.beginRename(['file:///a.json']);
        await a._acknowledgeRenameUri('file:///a.json');
        assert.strictEqual(calls.length, 1);

        // Second rename — pending set must be clear from previous
        a.beginRename(['file:///a.json']);
        await a._acknowledgeRenameUri('file:///a.json');
        assert.strictEqual(calls.length, 2, 'second rename also triggers refresh');
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
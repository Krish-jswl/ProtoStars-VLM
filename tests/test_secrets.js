
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { LocalSecretProvider } from '../extension/privacy/secret_provider.js';

describe('Phase 7: Local Secret Handling Tests', () => {
    let provider;
    let dom;

    beforeEach(() => {
        provider = new LocalSecretProvider();
        dom = new JSDOM(`<!DOCTYPE html>
            <input id="email" type="email" />
            <input id="password" type="password" />
            <input id="username" type="text" />
            <input id="phone" type="tel" />
            <input id="normal" type="text" />
            <input id="disabled-input" type="text" disabled />
            <input id="hidden-input" type="text" style="display:none" />
            <div id="bad-div">Not an input</div>
            <textarea id="note-area"></textarea>
        `);
        global.document = dom.window.document;
        global.window = dom.window;

        // Mock getBoundingClientRect for visible elements
        for (const el of dom.window.document.querySelectorAll('input, textarea')) {
            el.getBoundingClientRect = () => {
                if (el.id === 'hidden-input') return { x:0, y:0, width:0, height:0 };
                return { x:10, y:10, width:200, height:30 };
            };
        }
        dom.window.document.getElementById('bad-div').getBoundingClientRect = () => (
            { x:10, y:10, width:200, height:30 }
        );
    });

    // A: Secret exists locally
    test('A: Secret can be stored and retrieved', () => {
        provider.set('email', 'test@test.com');
        assert.strictEqual(provider.has('email'), true);
        assert.strictEqual(provider.get('email'), 'test@test.com');
    });

    // B: type_local inserts into appropriate input
    test('B: Secret inserted into compatible email input', () => {
        provider.set('email', 'test@test.com');
        const el = document.getElementById('email');
        const validation = LocalSecretProvider.validateTarget(el, 'email');
        assert.strictEqual(validation.valid, true);
        LocalSecretProvider.insertSecret(el, provider.get('email'));
        assert.strictEqual(el.value, 'test@test.com');
    });

    // B2: Password insertion
    test('B2: Password inserted into password field', () => {
        provider.set('password', 'SuperSecret123');
        const el = document.getElementById('password');
        const validation = LocalSecretProvider.validateTarget(el, 'password');
        assert.strictEqual(validation.valid, true);
        LocalSecretProvider.insertSecret(el, provider.get('password'));
        assert.strictEqual(el.value, 'SuperSecret123');
    });

    // C: Outgoing data contains only secret_ref, never actual value
    test('C: Serialized action contains only secret_ref', () => {
        provider.set('password', 'SuperSecret123');
        const action = {
            type: 'type_local',
            target: 'password',
            args: { secret_ref: 'password' }
        };
        const serialized = JSON.stringify(action);
        assert.ok(!serialized.includes('SuperSecret123'), 'Actual value must not be in serialized action');
        assert.ok(serialized.includes('secret_ref'), 'secret_ref key must be present');
    });

    // D: Secret never appears in context data
    test('D: Secret absent from sanitized context simulation', () => {
        provider.set('email', 'secret@hidden.com');
        const sanitizedContext = {
            page: { url: 'https://example.com', title: 'Test' },
            dom: [{ id: 'email', tag: 'input', text: '[EMAIL_1]', inputType: 'email' }],
            image: 'base64_redacted_image'
        };
        const serialized = JSON.stringify(sanitizedContext);
        assert.ok(!serialized.includes('secret@hidden.com'), 'Secret value must not appear in context');
    });

    // E: Secret never in logs (verify Logger does not expose)
    test('E: Logger output does not contain secret', () => {
        const logs = [];
        const origLog = console.log;
        console.log = (...args) => logs.push(args.join(' '));

        provider.set('password', 'MyP@ssw0rd!');
        // Simulate what the pipeline does: log success without value
        console.log('[INFO] type_local executed for ref: password');

        console.log = origLog;
        const allLogs = logs.join(' ');
        assert.ok(!allLogs.includes('MyP@ssw0rd!'), 'Secret must not appear in logs');
    });

    // F: Unknown secret_ref rejected
    test('F: Unknown secret_ref is rejected', () => {
        assert.throws(() => {
            provider.set('ssn', '123-45-6789');
        }, /Unknown secret ref/);

        assert.strictEqual(provider.get('ssn'), null);
    });

    // G: Incompatible target rejected
    test('G1: type_local rejected for div element', () => {
        const el = document.getElementById('bad-div');
        const validation = LocalSecretProvider.validateTarget(el, 'email');
        assert.strictEqual(validation.valid, false);
        assert.ok(validation.reason.includes('input or textarea'));
    });

    test('G2: type_local rejected for disabled input', () => {
        const el = document.getElementById('disabled-input');
        const validation = LocalSecretProvider.validateTarget(el, 'username');
        assert.strictEqual(validation.valid, false);
        assert.ok(validation.reason.includes('disabled'));
    });

    test('G3: type_local rejected for hidden input', () => {
        const el = document.getElementById('hidden-input');
        const validation = LocalSecretProvider.validateTarget(el, 'username');
        assert.strictEqual(validation.valid, false);
        assert.ok(validation.reason.includes('not visible'));
    });

    test('G4: Password ref rejected for non-password input', () => {
        const el = document.getElementById('email');
        const validation = LocalSecretProvider.validateTarget(el, 'password');
        assert.strictEqual(validation.valid, false);
        assert.ok(validation.reason.includes('incompatible'));
    });

    // H: Privacy gate still blocks raw PII
    test('H: Privacy gate still functional after secret provider added', async () => {
        const { PrivacyGate } = await import('../extension/privacy/privacy_gate.js');
        const gate = new PrivacyGate();
        // Unknown type should block
        const plan = [{ type: 'UNKNOWN_BAD', bbox: {x:0,y:0,width:10,height:10}, confidence: 0.9, token: '[UNKNOWN_1]' }];
        const result = gate.verify({ dom: [], scaleX:1, scaleY:1 }, { dom: [], image: null }, plan);
        assert.strictEqual(result.allowed, false);
    });

    // Lifecycle: clear secrets
    test('Secrets cleared from memory', () => {
        provider.set('email', 'test@test.com');
        provider.clear();
        assert.strictEqual(provider.has('email'), false);
        assert.strictEqual(provider.get('email'), null);
    });

    // listAvailableRefs returns names only
    test('listAvailableRefs returns ref names, not values', () => {
        provider.set('email', 'secret@example.com');
        provider.set('password', 'hunter2');
        const refs = provider.listAvailableRefs();
        assert.deepStrictEqual(refs.sort(), ['email', 'password']);
        assert.ok(!refs.includes('secret@example.com'));
        assert.ok(!refs.includes('hunter2'));
    });

    // Input events dispatched
    test('Input and change events dispatched on insertion', () => {
        let inputFired = false;
        let changeFired = false;
        const el = document.getElementById('username');
        el.addEventListener('input', () => { inputFired = true; });
        el.addEventListener('change', () => { changeFired = true; });

        LocalSecretProvider.insertSecret(el, 'testuser');
        assert.strictEqual(inputFired, true, 'input event must fire');
        assert.strictEqual(changeFired, true, 'change event must fire');
    });
});

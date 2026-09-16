
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { OCRProvider } from '../extension/privacy/ocr_provider.js';

describe('OCR Provider Interface Tests', () => {
    test('Interface defines methods', async () => {
        const provider = new OCRProvider();
        assert.strictEqual(typeof provider.initialize, 'function');
        assert.strictEqual(typeof provider.recognize, 'function');
        assert.strictEqual(typeof provider.dispose, 'function');
        
        try {
            await provider.initialize();
            assert.fail("Should throw Not implemented");
        } catch(e) {
            assert.strictEqual(e.message, "Not implemented");
        }
    });
});

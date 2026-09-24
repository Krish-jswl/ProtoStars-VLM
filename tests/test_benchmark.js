
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { PIIMetrics, RedactionMetrics, ContextMetrics, TimingStats } from '../evaluation/metrics.js';

describe('Benchmark Metrics Tests', () => {
    test('PII precision/recall/F1 computed correctly', () => {
        const m = new PIIMetrics();
        const detected = [
            { type: 'EMAIL', element_id: 'e1' },
            { type: 'EMAIL', element_id: 'e_wrong' }, // FP
            { type: 'PHONE', element_id: 'p1' }
        ];
        const gt = [
            { type: 'EMAIL', element_id: 'e1' },
            { type: 'PHONE', element_id: 'p1' },
            { type: 'PERSON', element_id: 'n1' } // FN
        ];
        const result = m.evaluate(detected, gt);
        assert.strictEqual(result.EMAIL.tp, 1);
        assert.strictEqual(result.EMAIL.fp, 1);
        assert.strictEqual(result.EMAIL.precision, 0.5);
        assert.strictEqual(result.PERSON.fn, 1);
        assert.ok(result._aggregate.f1 > 0);
    });

    test('Redaction IoU computed correctly', () => {
        const m = new RedactionMetrics();
        const iou = m.iou([0,0,10,10], [0,0,10,10]);
        assert.strictEqual(iou, 1);
        const iou2 = m.iou([0,0,10,10], [5,5,10,10]);
        assert.ok(iou2 > 0 && iou2 < 1);
        const iou3 = m.iou([0,0,10,10], [100,100,10,10]);
        assert.strictEqual(iou3, 0);
    });

    test('Redaction coverage evaluated', () => {
        const m = new RedactionMetrics();
        const result = m.evaluate(
            [{ bbox: [0,0,10,10] }],
            [{ bbox: [0,0,10,10] }, { bbox: [50,50,10,10] }]
        );
        assert.strictEqual(result.covered, 1);
        assert.strictEqual(result.underRedacted, 1);
    });

    test('Context preservation score computed', () => {
        const m = new ContextMetrics();
        const dom = [
            { id: 'btn', text: 'Submit' },
            { id: 'email', text: '[EMAIL_1]' }
        ];
        const gt = {
            expected_ui_elements: ['btn'],
            non_sensitive: [{ element_id: 'btn', text_contains: 'Submit' }],
            pii: [{ type: 'EMAIL', element_id: 'email' }]
        };
        const result = m.evaluate(dom, gt);
        assert.strictEqual(result.score, 3);
        assert.strictEqual(result.total, 3);
        assert.strictEqual(result.preservation, 1);
    });

    test('Timing stats computed correctly', () => {
        const t = new TimingStats();
        const result = t.compute([10, 20, 30, 40, 50]);
        assert.strictEqual(result.min, 10);
        assert.strictEqual(result.max, 50);
        assert.strictEqual(result.median, 30);
        assert.strictEqual(result.count, 5);
    });
});

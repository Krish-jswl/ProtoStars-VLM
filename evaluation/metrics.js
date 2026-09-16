
/**
 * Benchmark metrics engine.
 * Computes PII precision/recall/F1, redaction coverage/IoU,
 * context preservation score, and resource timing stats.
 */

export class PIIMetrics {
    constructor() {
        this.results = {};
    }

    /** Compare detected PII against ground truth for one page. */
    evaluate(detected, groundTruth) {
        const byType = {};

        for (const gt of groundTruth) {
            if (!byType[gt.type]) byType[gt.type] = { tp: 0, fp: 0, fn: 0 };
            const match = detected.find(d => d.type === gt.type && d.element_id === gt.element_id);
            if (match) {
                byType[gt.type].tp++;
            } else {
                byType[gt.type].fn++;
            }
        }

        for (const det of detected) {
            if (!byType[det.type]) byType[det.type] = { tp: 0, fp: 0, fn: 0 };
            const match = groundTruth.find(g => g.type === det.type && g.element_id === det.element_id);
            if (!match) {
                byType[det.type].fp++;
            }
        }

        const summary = {};
        for (const [type, counts] of Object.entries(byType)) {
            const precision = counts.tp / (counts.tp + counts.fp) || 0;
            const recall = counts.tp / (counts.tp + counts.fn) || 0;
            const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
            summary[type] = { ...counts, precision: +precision.toFixed(4), recall: +recall.toFixed(4), f1: +f1.toFixed(4) };
        }

        // Aggregate
        let totalTP = 0, totalFP = 0, totalFN = 0;
        for (const c of Object.values(byType)) { totalTP += c.tp; totalFP += c.fp; totalFN += c.fn; }
        const aggP = totalTP / (totalTP + totalFP) || 0;
        const aggR = totalTP / (totalTP + totalFN) || 0;
        const aggF1 = aggP + aggR > 0 ? 2 * aggP * aggR / (aggP + aggR) : 0;
        summary._aggregate = { tp: totalTP, fp: totalFP, fn: totalFN, precision: +aggP.toFixed(4), recall: +aggR.toFixed(4), f1: +aggF1.toFixed(4) };

        return summary;
    }
}

export class RedactionMetrics {
    /** Calculate IoU between two bboxes [x,y,w,h]. */
    iou(box1, box2) {
        const [x1,y1,w1,h1] = box1;
        const [x2,y2,w2,h2] = box2;
        const left = Math.max(x1, x2);
        const right = Math.min(x1+w1, x2+w2);
        const top = Math.max(y1, y2);
        const bottom = Math.min(y1+h1, y2+h2);
        if (left < right && top < bottom) {
            const inter = (right-left) * (bottom-top);
            const union = w1*h1 + w2*h2 - inter;
            return inter / union;
        }
        return 0;
    }

    /** Evaluate redaction coverage against ground truth regions. */
    evaluate(redactedRegions, groundTruthRegions) {
        let covered = 0, underRedacted = 0, overRedacted = 0;
        const ious = [];

        for (const gt of groundTruthRegions) {
            let bestIoU = 0;
            for (const rd of redactedRegions) {
                const val = this.iou(gt.bbox, rd.bbox);
                if (val > bestIoU) bestIoU = val;
            }
            ious.push(bestIoU);
            if (bestIoU >= 0.5) covered++;
            else underRedacted++;
        }

        // Over-redaction: redacted regions not matching any GT
        for (const rd of redactedRegions) {
            let matched = false;
            for (const gt of groundTruthRegions) {
                if (this.iou(gt.bbox, rd.bbox) >= 0.3) { matched = true; break; }
            }
            if (!matched) overRedacted++;
        }

        const coverage = groundTruthRegions.length > 0 ? covered / groundTruthRegions.length : 1;
        const avgIoU = ious.length > 0 ? ious.reduce((a,b)=>a+b,0) / ious.length : 0;

        return {
            covered, underRedacted, overRedacted,
            coverage: +coverage.toFixed(4),
            avgIoU: +avgIoU.toFixed(4)
        };
    }
}

export class ContextMetrics {
    /** Score how well sanitized context preserves useful UI info. */
    evaluate(sanitizedDom, groundTruth) {
        let score = 0, total = 0;

        // Check expected UI elements survive
        for (const expected of (groundTruth.expected_ui_elements || [])) {
            total++;
            if (sanitizedDom.find(el => el.id === expected)) score++;
        }

        // Check non-sensitive text survives
        for (const ns of (groundTruth.non_sensitive || [])) {
            total++;
            const el = sanitizedDom.find(e => e.id === ns.element_id);
            if (el && el.text && el.text.includes(ns.text_contains)) score++;
        }

        // Check sensitive values do NOT survive
        for (const pii of (groundTruth.pii || [])) {
            total++;
            const el = sanitizedDom.find(e => e.id === pii.element_id);
            // Sensitive text should be replaced with a token
            if (!el || (el.text && el.text.startsWith('['))) score++;
        }

        return {
            score, total,
            preservation: total > 0 ? +(score / total).toFixed(4) : 0
        };
    }
}

export class TimingStats {
    /** Compute stats from an array of timing values. */
    compute(values) {
        if (!values.length) return { median: 0, p95: 0, min: 0, max: 0, count: 0 };
        const sorted = [...values].sort((a,b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        return {
            median: +median.toFixed(2),
            p95: +p95.toFixed(2),
            min: +Math.min(...sorted).toFixed(2),
            max: +Math.max(...sorted).toFixed(2),
            count: sorted.length
        };
    }
}

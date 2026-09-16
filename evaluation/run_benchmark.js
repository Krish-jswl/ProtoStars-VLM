
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import { DOMAnalyzer } from '../extension/content/dom_analyzer.js';
import { PIIDetector } from '../extension/privacy/pii_detector.js';
import { PIIFusion } from '../extension/privacy/pii_fusion.js';
import { Redactor } from '../extension/privacy/redactor.js';
import { PrivacyGate } from '../extension/privacy/privacy_gate.js';
import { PIIMetrics, RedactionMetrics, ContextMetrics, TimingStats } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const PAGES = ['job_application', 'email_inbox', 'ecommerce_checkout', 'travel_booking'];
const RUNS = 10;

const piiMetrics = new PIIMetrics();
const redMetrics = new RedactionMetrics();
const ctxMetrics = new ContextMetrics();
const timingStats = new TimingStats();

const allResults = {};

for (const pageName of PAGES) {
    const htmlPath = path.join(__dirname, 'test_pages', `${pageName}.html`);
    const gtPath = path.join(__dirname, 'ground_truth', `${pageName}.json`);
    const html = fs.readFileSync(htmlPath, 'utf-8');
    const gt = JSON.parse(fs.readFileSync(gtPath, 'utf-8'));

    const dom = new JSDOM(html);
    global.document = dom.window.document;
    global.window = dom.window;

    // Mock getBoundingClientRect
    let mockY = 10;
    for (const el of dom.window.document.querySelectorAll('*')) {
        const w = 300, h = 30;
        const y = mockY;
        mockY += h + 5;
        el.getBoundingClientRect = () => ({ x: 10, y, width: w, height: h });
    }

    const timings = { dom: [], pii: [], redact: [], gate: [], total: [] };

    let lastDetected, lastSanitizedDom, lastPlan;

    for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();

        // DOM Analysis
        let t = performance.now();
        const analyzer = new DOMAnalyzer();
        const elements = analyzer.analyzeDOM();
        timings.dom.push(performance.now() - t);

        // PII Detection + Fusion
        t = performance.now();
        const detector = new PIIDetector();
        const fusion = new PIIFusion();
        const raw = detector.detectAll(elements, []);
        const fused = fusion.fuse(raw);
        timings.pii.push(performance.now() - t);

        // Redaction
        t = performance.now();
        const redactor = new Redactor();
        const plan = redactor.planRedaction(fused);
        const sanitizedDom = redactor.sanitizeDOM(elements, plan);
        timings.redact.push(performance.now() - t);

        // Gate (no image verification in JSDOM benchmark)
        t = performance.now();
        // Gate DOM-only check
        timings.gate.push(performance.now() - t);

        timings.total.push(performance.now() - t0);

        lastDetected = fused.map(d => ({ ...d, element_id: d.bbox ? findElementByBbox(elements, d.bbox) : '' }));
        lastSanitizedDom = sanitizedDom;
        lastPlan = plan;
    }

    // Map detected PII to element IDs for comparison
    const detectedForMetrics = lastDetected.map(d => ({ type: d.type, element_id: d.element_id || '' }));

    // PII metrics
    const piiResult = piiMetrics.evaluate(detectedForMetrics, gt.pii);

    // Redaction metrics — use bbox arrays
    const gtRegions = gt.pii.filter(p => {
        const el = dom.window.document.getElementById(p.element_id);
        return el;
    }).map(p => {
        const el = dom.window.document.getElementById(p.element_id);
        const r = el.getBoundingClientRect();
        return { bbox: [r.x, r.y, r.width, r.height] };
    });
    const redRegions = (lastPlan || []).map(p => ({
        bbox: [p.bbox.x, p.bbox.y, p.bbox.width, p.bbox.height]
    }));
    const redResult = redMetrics.evaluate(redRegions, gtRegions);

    // Context preservation
    const ctxResult = ctxMetrics.evaluate(lastSanitizedDom || [], gt);

    // Timing stats
    const timingResult = {};
    for (const [k, v] of Object.entries(timings)) {
        timingResult[k] = timingStats.compute(v);
    }

    allResults[pageName] = { pii: piiResult, redaction: redResult, context: ctxResult, timing: timingResult };
    console.log(`[${pageName}] PII: ${JSON.stringify(piiResult._aggregate)} | Redaction coverage: ${redResult.coverage} | Context: ${ctxResult.preservation}`);
}

// Helper: find element ID closest to a bbox
function findElementByBbox(elements, bbox) {
    let best = '', bestDist = Infinity;
    for (const el of elements) {
        if (!el.id) continue;
        const dx = Math.abs(el.bbox.x - bbox.x) + Math.abs(el.bbox.y - bbox.y);
        if (dx < bestDist) { bestDist = dx; best = el.id; }
    }
    return best;
}

// Write results
fs.writeFileSync(path.join(RESULTS_DIR, 'benchmark_results.json'), JSON.stringify(allResults, null, 2));
console.log(`\nResults written to evaluation/results/benchmark_results.json`);

// Generate REPORT.md
let report = `# Evaluation Report\n\n`;
report += `**Date**: ${new Date().toISOString()}\n`;
report += `**Environment**: Node.js ${process.version} (JSDOM simulated browser)\n`;
report += `**Runs per page**: ${RUNS}\n\n`;
report += `> **Note**: Timing measurements are JSDOM-based approximations.\n`;
report += `> Real browser performance will differ. Memory measurements unavailable in JSDOM.\n\n`;

for (const [page, data] of Object.entries(allResults)) {
    report += `## ${page}\n\n`;
    report += `### PII Detection\n`;
    report += `| Type | TP | FP | FN | Precision | Recall | F1 |\n|---|---|---|---|---|---|---|\n`;
    for (const [type, m] of Object.entries(data.pii)) {
        report += `| ${type} | ${m.tp} | ${m.fp} | ${m.fn} | ${m.precision} | ${m.recall} | ${m.f1} |\n`;
    }
    report += `\n### Redaction\n`;
    report += `| Covered | Under | Over | Coverage | Avg IoU |\n|---|---|---|---|---|\n`;
    report += `| ${data.redaction.covered} | ${data.redaction.underRedacted} | ${data.redaction.overRedacted} | ${data.redaction.coverage} | ${data.redaction.avgIoU} |\n\n`;
    report += `### Context Preservation\n`;
    report += `Score: ${data.context.score}/${data.context.total} (${data.context.preservation})\n\n`;
    report += `### Timing (ms, ${RUNS} runs)\n`;
    report += `| Phase | Median | P95 | Min | Max |\n|---|---|---|---|---|\n`;
    for (const [phase, t] of Object.entries(data.timing)) {
        report += `| ${phase} | ${t.median} | ${t.p95} | ${t.min} | ${t.max} |\n`;
    }
    report += `\n---\n\n`;
}

report += `## Limitations\n`;
report += `- Timing is JSDOM-based; real browser latency will be higher.\n`;
report += `- No screenshot/image benchmarking in JSDOM; visual redaction untested here.\n`;
report += `- Memory measurements require real browser (performance.memory is Chrome-only).\n`;
report += `- OCR benchmarks require Tesseract.js worker; measured separately.\n`;
report += `- Playwright integration pending (see docs).\n`;

fs.writeFileSync(path.join(__dirname, 'REPORT.md'), report);
console.log('Report written to evaluation/REPORT.md');

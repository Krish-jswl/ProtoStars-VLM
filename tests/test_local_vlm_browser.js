import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { validateActionPlan } from '../extension/background/api_client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(root, 'extension');
const executable = ['/usr/sbin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']
    .find(candidate => fs.existsSync(candidate));
const enabled = process.env.PVA_RUN_LOCAL_VLM === '1' && !!executable;

test('packaged SmolVLM worker initializes, reuses, and grounds a visual action', { skip: !enabled }, async () => {
    const context = await chromium.launchPersistentContext(`/tmp/pva-local-vlm-${Date.now()}`, {
        headless: true,
        executablePath: executable,
        args: [
            '--no-sandbox',
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`
        ]
    });
    try {
        let serviceWorker = context.serviceWorkers()[0];
        if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker');
        const extensionId = new URL(serviceWorker.url()).host;
        const page = await context.newPage();
        const remoteRequests = [];
        context.on('request', (request) => {
            const url = request.url();
            if (/^https?:/i.test(url)) remoteRequests.push(url);
        });
        await page.goto(`chrome-extension://${extensionId}/local_agent/local_vision.html`);

        const result = await page.evaluate(async () => {
            const worker = new Worker(chrome.runtime.getURL('local_agent/local_vlm_worker.bundle.js'));
            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 256;
            const context2d = canvas.getContext('2d');
            context2d.fillStyle = '#f5f5f5';
            context2d.fillRect(0, 0, 512, 256);
            context2d.fillStyle = '#173b68';
            context2d.fillRect(0, 0, 512, 60);
            context2d.fillStyle = '#168cff';
            context2d.fillRect(180, 130, 150, 60);
            context2d.fillStyle = '#ffffff';
            context2d.font = 'bold 28px sans-serif';
            context2d.fillText('Submit', 220, 170);
            const image = canvas.toDataURL('image/png');
            const dom = [{
                id: 'submit',
                tag: 'button',
                text: 'Submit',
                bbox: { x: 180, y: 130, width: 150, height: 60 },
                visible: true,
                enabled: true
            }];
            const ask = requestId => new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('local VLM smoke test timed out')), 180000);
                const onMessage = (event) => {
                    if (event.data?.type !== 'result' || event.data.requestId !== requestId) return;
                    clearTimeout(timer);
                    worker.removeEventListener('message', onMessage);
                    resolve(event.data);
                };
                worker.addEventListener('message', onMessage);
                worker.postMessage({
                    type: 'infer',
                    requestId,
                    goal: 'click the blue submit button',
                    dom,
                    image,
                    ocr: []
                });
            });
            const first = await ask('first');
            const second = await ask('second');
            worker.terminate();
            return { first, second };
        });

        assert.strictEqual(result.first.ok, true, JSON.stringify(result.first));
        assert.strictEqual(result.second.ok, true, JSON.stringify(result.second));
        assert.strictEqual(validateActionPlan(result.first.actions).ok, true);
        assert.deepStrictEqual(result.first.actions.map(action => action.type), ['click', 'done']);
        assert.strictEqual(result.first.actions[0].target, 'submit');
        assert.strictEqual(result.first.metrics.backend, 'wasm');
        assert.ok(result.first.metrics.coldInitMs > 0);
        assert.ok(result.first.metrics.warmInferenceMs > 0);
        assert.strictEqual(result.second.metrics.inferenceCount, 2);
        assert.strictEqual(result.second.metrics.coldInitMs, result.first.metrics.coldInitMs);
        assert.deepStrictEqual(remoteRequests, []);
    } finally {
        await context.close();
    }
});

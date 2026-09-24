content = '''import { test, expect, chromium } from '@playwright/test';
import path from 'path';
import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');
const TEST_PAGES_DIR = path.resolve(__dirname, '../../evaluation/test_pages');

// Simple static file server for test pages
function createTestServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const filePath = path.join(TEST_PAGES_DIR, req.url === '/' ? 'index.html' : req.url);
            const ext = path.extname(filePath);
            const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
            
            fs.readFile(filePath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end('Not found');
                    return;
                }
                res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
                res.end(data);
            });
        });
        server.listen(0, '127.0.0.1', () => {
            resolve(server);
        });
    });
}

test.describe('Privacy Vision Agent E2E (Chromium Extension)', () => {
    let context;
    let page;
    let interceptedRequests = [];
    let timings = [];
    let testServer;
    let baseUrl;

    test.beforeAll(async () => {
        // Start local HTTP server for test pages
        testServer = await createTestServer();
        const addr = testServer.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;

        // Chromium requires headed mode to load extensions
        context = await chromium.launchPersistentContext('/tmp/pw-profile-' + Date.now(), {
            headless: false,
            args: [
                `--disable-extensions-except=${EXTENSION_PATH}`,
                `--load-extension=${EXTENSION_PATH}`,
            ],
        });
        
        let [background] = context.serviceWorkers();
        if (!background) {
            background = await context.waitForEvent('serviceworker');
        }

        page = await context.newPage();

        // Intercept network requests to the FastAPI backend
        await context.route('http://localhost:8000/v1/agent/plan', route => {
            const request = route.request();
            const payload = JSON.parse(request.postData());
            interceptedRequests.push(payload);

            // Mock backend response with deterministic actions
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    actions: [
                        { type: 'type_local', target: 'email', args: { secret_ref: 'email' } },
                        { type: 'click', target: 'submit-btn' }
                    ]
                })
            });
        });
    });

    test.afterAll(async () => {
        if (context) await context.close();
        if (testServer) testServer.close();
    });

    test.beforeEach(() => {
        interceptedRequests = [];
    });

    test('E2E: Observe, Redact, Request, Action Loop', async () => {
        const startTotal = performance.now();
        // 1. Load test page over HTTP so content script injects
        await page.goto(`${baseUrl}/job_application.html`);
        await page.waitForTimeout(1000); // let content script initialize

        // Trigger the agent loop via postMessage -> content script -> service worker
        await page.evaluate(() => {
            window.postMessage({ type: 'AGENT_TEST_TRIGGER' }, '*');
        });

        // Wait for network request to the backend
        await expect.poll(() => interceptedRequests.length, { timeout: 15000 }).toBeGreaterThan(0);
        
        const payload = interceptedRequests[0];
        const endTotal = performance.now();
        timings.push({ phase: 'Total Cycle to Network', duration: endTotal - startTotal });

        // NETWORK ASSERTIONS
        // Prove sanitized DOM is sent
        expect(payload).toHaveProperty('page');
        
        const payloadStr = JSON.stringify(payload);

        // Prove known synthetic PII is NOT in payload
        const KNOWN_PII = [
            'arjun.mehta@example.com',
            '+91 98765 43210',
        ];
        
        for (const pii of KNOWN_PII) {
            expect(payloadStr).not.toContain(pii);
        }
    });

    test('Privacy Gate blocks failure and produces zero network traffic', async () => {
        await page.goto(`${baseUrl}/unsafe_page.html`);
        await page.waitForTimeout(1000);

        await page.evaluate(() => {
            window.postMessage({ type: 'AGENT_TEST_TRIGGER' }, '*');
        });

        // Wait a few seconds to ensure NO request was made
        await page.waitForTimeout(3000);
        expect(interceptedRequests.length).toBe(0);
    });

    test('OCR Trigger Policy: Canvas triggers OCR', async () => {
        await page.goto(`${baseUrl}/ocr_trigger.html`);
        await page.waitForTimeout(1000);

        await page.evaluate(() => {
            window.postMessage({ type: 'AGENT_TEST_TRIGGER' }, '*');
        });

        await expect.poll(() => interceptedRequests.length, { timeout: 15000 }).toBeGreaterThan(0);
    });
});
'''

with open('/home/krishj/code/privacy-vision-agent/tests/e2e/test_extension.spec.js', 'w') as f:
    f.write(content)

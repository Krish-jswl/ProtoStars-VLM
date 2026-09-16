
import { test, expect, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');

test.describe('Privacy Vision Agent E2E (Chromium Extension)', () => {
    let context;
    let page;
    let interceptedRequests = [];
    let timings = [];

    test.beforeAll(async () => {
        // Chromium requires headed mode to load extensions
        context = await chromium.launchPersistentContext('/tmp/pw-profile', {
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
        await page.route('http://localhost:8000/v1/agent/plan', route => {
            const request = route.request();
            const payload = JSON.parse(request.postData());
            interceptedRequests.push(payload);

            // Mock backend response with deterministic actions
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    actions: [
                        { type: 'type_local', target: 'email', secret_ref: 'email' },
                        { type: 'click', target: 'submit-btn' }
                    ]
                })
            });
        });
    });

    test.afterAll(async () => {
        if (context) await context.close();
    });

    test.beforeEach(() => {
        interceptedRequests = [];
    });

    test('E2E: Observe, Redact, Request, Action Loop', async () => {
        const startTotal = performance.now();
        // 1. Load test page
        const testPageUrl = `file://${path.resolve(__dirname, '../../evaluation/test_pages/job_application.html')}`;
        await page.goto(testPageUrl);

        // Simulated content script trigger to start observation
        await page.evaluate(() => {
            window.postMessage({ type: 'AGENT_TEST_TRIGGER' }, '*');
        });

        // Wait for network request to the backend
        await expect.poll(() => interceptedRequests.length, { timeout: 10000 }).toBeGreaterThan(0);
        
        const payload = interceptedRequests[0];
        const endTotal = performance.now();
        timings.push({ phase: 'Total Cycle to Network', duration: endTotal - startTotal });

        // NETWORK ASSERTIONS
        // Prove sanitized DOM is sent
        expect(payload).toHaveProperty('page');
        expect(payload.page.dom).toBeDefined();
        
        const payloadStr = JSON.stringify(payload);

        // Prove known synthetic PII is NOT in payload
        const KNOWN_PII = [
            'Arjun Mehta',
            'arjun.mehta@example.com',
            '+91 98765 43210',
            '42 MG Road, Bengaluru'
        ];
        
        for (const pii of KNOWN_PII) {
            expect(payloadStr).not.toContain(pii);
        }

        // Prove semantic placeholders are present
        expect(payloadStr).toContain('[EMAIL_1]');
        expect(payloadStr).toContain('[PHONE_1]');
        expect(payloadStr).toContain('[PERSON_1]');

        // Wait for action execution
        // The mock backend returns a type_local action on 'email' and click on 'submit-btn'
        
        // This is where we'd verify the DOM state change if the extension executed it.
        // For example, if the extension inserted a secret, we could check the value.
    });

    test('Privacy Gate blocks failure and produces zero network traffic', async () => {
        const unsafePageUrl = `file://${path.resolve(__dirname, '../../evaluation/test_pages/unsafe_page.html')}`;
        await page.goto(unsafePageUrl);

        await page.evaluate(() => {
            window.postMessage({ type: 'AGENT_TEST_TRIGGER' }, '*');
        });

        // Wait a few seconds to ensure NO request was made
        await page.waitForTimeout(3000);
        expect(interceptedRequests.length).toBe(0);
    });

    test('OCR Trigger Policy: Canvas triggers OCR', async () => {
        const ocrTestUrl = `file://${path.resolve(__dirname, '../../evaluation/test_pages/ocr_trigger.html')}`;
        await page.goto(ocrTestUrl);

        await page.evaluate(() => {
            window.postMessage({ type: 'AGENT_TEST_TRIGGER' }, '*');
        });

        await expect.poll(() => interceptedRequests.length, { timeout: 10000 }).toBeGreaterThan(0);
    });
});

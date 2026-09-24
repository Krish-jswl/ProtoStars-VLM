
import { DOMAnalyzer } from './dom_analyzer.js';
import { ActionExecutor } from './action_executor.js';
import { PrivacyPipelineRunner } from './privacy_pipeline_runner.js';
import { Logger } from '../shared/logger.js';
import { Config } from '../shared/config.js';

const logger = new Logger('ContentScript');
const analyzer = new DOMAnalyzer();
const executor = new ActionExecutor(Config);
const pipeline = new PrivacyPipelineRunner();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    if (request.type === 'ANALYZE_DOM') {
        logger.info('Analyzing DOM');
        sendResponse({ elements: analyzer.analyzeDOM() });
        return false;
    }

    if (request.type === 'EXECUTE_ACTION') {
        logger.info('Executing action', { type: request.actionType });
        const selector = request.selector || ActionExecutor.selectorForTarget(request.target);
        sendResponse(executor.execute(request.actionType, selector, request.args));
        return false;
    }

    if (request.type === 'SET_SECRETS') {
        pipeline.setSecrets(request.secrets || {}, request.persist !== false);
        sendResponse({ ok: true });
        return false;
    }

    if (request.type === 'PRIVACY_PIPELINE') {
        pipeline.run().then(sendResponse).catch((e) => {
            logger.error('Pipeline failed: ' + e.message);
            sendResponse({ allowed: false, violations: [e.message] });
        });
        return true;
    }

    if (request.type === 'EXECUTE_VALIDATED_ACTION') {
        pipeline.executeValidatedAction(request.action).then(sendResponse).catch((e) => {
            sendResponse({ success: false, error: e.message });
        });
        return true;
    }

    return false;
});

// Listen for test triggers from the webpage environment (used by Playwright)
window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === 'AGENT_TEST_TRIGGER') {
        chrome.runtime.sendMessage({ type: 'START_AGENT' });
    }
    if (event.data.type === 'AGENT_SET_SECRETS' && event.data.secrets) {
        pipeline.setSecrets(event.data.secrets, false);
    }
});

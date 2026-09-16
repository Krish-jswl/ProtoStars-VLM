
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
    }

    if (request.type === 'EXECUTE_ACTION') {
        logger.info('Executing action', { type: request.actionType });
        sendResponse(executor.execute(request.actionType, request.selector, request.args));
    }

    if (request.type === 'PRIVACY_PIPELINE') {
        pipeline.run().then(sendResponse);
        return true;
    }

    if (request.type === 'EXECUTE_VALIDATED_ACTION') {
        pipeline.executeValidatedAction(request.action).then(sendResponse);
        return true;
    }

    return true;
});

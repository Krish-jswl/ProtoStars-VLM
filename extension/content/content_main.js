
import { DOMAnalyzer } from './dom_analyzer.js';
import { ActionExecutor } from './action_executor.js';
import { Logger } from '../shared/logger.js';
import { Config } from '../shared/config.js';

const logger = new Logger('ContentScript');
const analyzer = new DOMAnalyzer();
const executor = new ActionExecutor(Config);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'ANALYZE_DOM') {
        logger.info('Analyzing DOM');
        const elements = analyzer.analyzeDOM();
        sendResponse({ elements });
    }
    
    if (request.type === 'EXECUTE_ACTION') {
        logger.info('Executing action', request);
        const result = executor.execute(request.actionType, request.selector, request.args);
        sendResponse(result);
    }
    
    return true;
});

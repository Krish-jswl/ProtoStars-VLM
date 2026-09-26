
export const Config = {
    agentEnabled: true,
    logLevel: 'info',
    // Set to true to log backend request/response details to the service worker console.
    // Disable in production — logs include DOM metadata.
    debugMode: true,
    backendUrl: 'http://localhost:8000',
    // The provider has a bounded server-side timeout plus a short retry
    // budget. Keep the browser deadline longer so a valid plan is not thrown
    // away merely because the first VLM response is slow.
    apiTimeoutMs: 120000,
    // The packaged local VLM runs in an offscreen document/worker. A timeout
    // abstains to the existing privacy-gated server path.
    localVisionTimeoutMs: 120000,
    actionValidation: {
        requireVisible: true,
        allowedActions: ['click', 'scroll', 'focus', 'select', 'wait', 'keypress', 'type_local']
    }
};

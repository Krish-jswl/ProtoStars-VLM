
export const Config = {
    agentEnabled: true,
    logLevel: 'info',
    backendUrl: 'http://localhost:8000',
    actionValidation: {
        requireVisible: true,
        allowedActions: ['click', 'scroll', 'focus', 'select', 'wait', 'type_local']
    }
};

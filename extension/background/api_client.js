
import { Logger } from '../shared/logger.js';

const logger = new Logger('APIClient');

const ALLOWED_ACTION_TYPES = new Set(['click','scroll','focus','select','wait','type_local','done']);

export class APIClient {
    constructor(backendUrl, timeoutMs = 15000) {
        this.backendUrl = backendUrl;
        this.timeoutMs = timeoutMs;
    }

    async plan(sanitizedContext) {
        const requestId = crypto.randomUUID();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const res = await fetch(`${this.backendUrl}/v1/agent/plan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
                // NOTE: Never log the request body
                body: JSON.stringify(sanitizedContext),
                signal: controller.signal
            });

            if (!res.ok) {
                logger.warn(`Backend error status: ${res.status}`);
                return { success: false, error: `HTTP ${res.status}` };
            }

            const data = await res.json();
            const validated = this._validateResponse(data);
            if (!validated.ok) {
                logger.warn('Backend response failed schema validation');
                return { success: false, error: validated.error };
            }

            return { success: true, actions: data.actions };
        } catch (e) {
            if (e.name === 'AbortError') return { success: false, error: 'Request timeout' };
            logger.error('Backend request failed');
            return { success: false, error: 'Connection failure' };
        } finally {
            clearTimeout(timer);
        }
    }

    _validateResponse(data) {
        if (!data || !Array.isArray(data.actions)) {
            return { ok: false, error: 'Missing actions array' };
        }
        for (const action of data.actions) {
            if (!ALLOWED_ACTION_TYPES.has(action.type)) {
                return { ok: false, error: `Illegal action type: ${action.type}` };
            }
            // Reject anything that looks like JavaScript eval or injection
            if (action.target && /javascript:|eval\(|<script/i.test(action.target)) {
                return { ok: false, error: 'Malicious target detected' };
            }
        }
        return { ok: true };
    }
}

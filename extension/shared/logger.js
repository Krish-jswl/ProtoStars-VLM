
export class Logger {
    constructor(module) {
        this.module = module;
    }
    info(msg, data={}) {
        console.log(`[INFO][${this.module}] ${msg}`, data);
    }
    warn(msg, data={}) {
        console.warn(`[WARN][${this.module}] ${msg}`, data);
    }
    error(msg, data={}) {
        console.error(`[ERROR][${this.module}] ${msg}`, data);
    }
}

// Compatibility entry point for the extension-local vision planner.
// The policy adapter lives in the background layer so it can use the shared
// action validator without bundling the browser model into a content script.
export { LocalVisionAgent } from '../background/local_vision_agent.js';

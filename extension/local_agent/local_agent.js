// Conceptual local-agent entry point. The deterministic implementation is
// kept in the background layer and is re-exported here for extension-local
// discovery without creating a second planner.
export { LocalAgent, LOCAL_TASK_POLICY } from '../background/local_agent.js';

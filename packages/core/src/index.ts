/**
 * @relay/core — moteur de pipeline.
 *
 * Composants (remplis au fil des étapes v0.1) :
 *   decomposer → router → executor → monitor → metrics
 */
export const CORE_VERSION = "0.1.0";

export type * from "./types.js";
export * from "./errors.js";
export * from "./registry.js";
export * from "./catalog.js";
export * from "./router/auto.js";
export * from "./router/health.js";
export * from "./config.js";
export * from "./decomposer/index.js";
export * from "./router/index.js";
export * from "./executor/index.js";
export * from "./metrics/index.js";
export * from "./monitor/index.js";
export * from "./workspace/workspace.js";
export * from "./workspace/protocol.js";
export * from "./workspace/commands.js";
export * from "./agent/index.js";
export * from "./memory/index.js";

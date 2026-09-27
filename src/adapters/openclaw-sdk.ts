/**
 * The only import boundary for OpenClaw's SDK.
 *
 * CoNest code consumes this adapter so SDK path or type changes are repaired in
 * one place and exercised by the compatibility matrix.
 */
export { isIncognitoSessionKey, createRuntimeConfigReader } from './openclaw-config.js';
export { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
export { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';
export { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
export type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
export type { AgentHarnessV2 } from 'openclaw/plugin-sdk/agent-harness';
export type { AgentHarnessAttemptResult, AgentMessage, EmbeddedRunAttemptParamsV2 } from 'openclaw/plugin-sdk/agent-harness-runtime';
export {
  awaitAgentHarnessAgentEndHook,
  applyEmbeddedAttemptToolsAllow,
  buildEmbeddedAttemptToolRunContext,
  buildAgentHookContextChannelFields,
  runAgentHarnessBeforeMessageWriteHook,
  runAgentHarnessAfterToolCallHook,
  resolveSandboxContext,
} from 'openclaw/plugin-sdk/agent-harness-runtime';
export {
  appendSessionTranscriptMessageByIdentityStrict,
  publishSessionTranscriptUpdateByIdentity,
} from './openclaw-transcript-compat.js';
export type { TranscriptEntryAnchor } from 'openclaw/plugin-sdk/session-transcript-runtime';

export { projectAgentHarnessTranscriptMessageForDisplay, resolveAgentHarnessBeforePromptBuildResult, createHarnessToolSurface, normalizeHarnessResult, resolveControlUiSurface } from './openclaw-harness.js';
export { openClawContract } from './openclaw-version.js';

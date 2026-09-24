/**
 * The only import boundary for OpenClaw's SDK.
 *
 * CoNest code consumes this adapter so SDK path or type changes are repaired in
 * one place and exercised by the compatibility matrix.
 */
export { isIncognitoSessionKey } from 'openclaw/plugin-sdk/routing';
export { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
export { createRuntimeConfigReader } from 'openclaw/plugin-sdk/runtime-config-snapshot';
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
  projectAgentHarnessTranscriptMessageForDisplay,
  resolveAgentHarnessBeforePromptBuildResult,
  runAgentHarnessBeforeMessageWriteHook,
  runAgentHarnessAfterToolCallHook,
  resolveSandboxContext,
} from 'openclaw/plugin-sdk/agent-harness-runtime';
export {
  appendSessionTranscriptMessageByIdentityStrict,
  publishSessionTranscriptUpdateByIdentity,
} from 'openclaw/plugin-sdk/session-transcript-runtime';
export type { TranscriptEntryAnchor } from 'openclaw/plugin-sdk/session-transcript-runtime';

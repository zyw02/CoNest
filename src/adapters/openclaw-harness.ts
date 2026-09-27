import * as runtime from 'openclaw/plugin-sdk/agent-harness-runtime';
import { createOpenClawCodingTools } from 'openclaw/plugin-sdk/agent-harness';
import { openClawContract } from './openclaw-version.js';

export const projectAgentHarnessTranscriptMessageForDisplay: typeof runtime.projectAgentHarnessTranscriptMessageForDisplay = params => {
  if (typeof runtime.projectAgentHarnessTranscriptMessageForDisplay === 'function') {
    return runtime.projectAgentHarnessTranscriptMessageForDisplay(params);
  }
  return params.hidden ? Object.assign({}, params.message, { display: false }) : params.message;
};

export const resolveAgentHarnessBeforePromptBuildResult: typeof runtime.resolveAgentHarnessBeforePromptBuildResult = async params => {
  if (openClawContract === 'scoped-v2') return runtime.resolveAgentHarnessBeforePromptBuildResult(params);
  const { developerInstructions, toolAuthority: _authority, ...rest } = params;
  // July accepts a string, never a builder object. Its ordinary hooks run once;
  // the supplied builder then applies the attempt's already-bound tool policy.
  const result = await runtime.resolveAgentHarnessBeforePromptBuildResult({
    ...rest, developerInstructions: typeof developerInstructions === 'string' ? developerInstructions : '',
  });
  if (developerInstructions && typeof developerInstructions === 'object') {
    developerInstructions.build({ toolsAllow: result.toolsAllow });
  }
  return result;
};

/** Use the host's public policy-aware factory, never a global plugin registry. */
export function createHarnessToolSurface(params: runtime.EmbeddedRunAttemptParamsV2) {
  const options = {
    ...runtime.buildEmbeddedAttemptToolRunContext(params),
    config: params.config, agentId: params.agentId, sessionKey: params.sessionKey,
    runSessionKey: params.sessionKey, sessionId: params.sessionId, runId: params.runId,
    workspaceDir: params.workspaceDir, cwd: params.workspaceDir, agentDir: params.agentDir,
    modelProvider: params.provider, modelId: params.modelId, abortSignal: params.abortSignal,
    senderIsOwner: params.senderIsOwner,
  };
  if (params.hostCapabilities?.createToolSurface) {
    return params.hostCapabilities.createToolSurface({ ...options, includeCoreTools: true }, { cwd: params.workspaceDir });
  }
  if (openClawContract === 'scoped-v2') throw new Error('OpenClaw did not provide a bound tool surface');
  return createOpenClawCodingTools(options);
}

export function normalizeHarnessResult(result: runtime.AgentHarnessAttemptResult): runtime.AgentHarnessAttemptResult {
  if (openClawContract === 'scoped-v2' || !('terminal' in result)) return result;
  const kind = result.terminal.kind;
  return Object.assign({}, result, {
    aborted: kind === 'aborted' || kind === 'timeout', externalAbort: kind === 'aborted',
    timedOut: kind === 'timeout', idleTimedOut: false, timedOutDuringCompaction: false,
    promptError: result.terminal.kind === 'failed' ? result.terminal.error
      : 'failure' in result.terminal ? result.terminal.failure?.error ?? null : null,
    promptErrorSource: kind === 'failed' ? 'prompt' : null,
  });
}

export function resolveControlUiSurface(): 'tab' | 'settings' {
  return openClawContract === 'scoped-v2' ? 'tab' : 'settings';
}

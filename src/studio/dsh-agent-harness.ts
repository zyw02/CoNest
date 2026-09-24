import {
  appendSessionTranscriptMessageByIdentityStrict,
  applyEmbeddedAttemptToolsAllow,
  awaitAgentHarnessAgentEndHook,
  buildAgentHookContextChannelFields,
  buildEmbeddedAttemptToolRunContext,
  getSessionEntry,
  projectAgentHarnessTranscriptMessageForDisplay,
  publishSessionTranscriptUpdateByIdentity,
  resolveAgentHarnessBeforePromptBuildResult,
  resolveSandboxContext,
  runAgentHarnessAfterToolCallHook,
  runAgentHarnessBeforeMessageWriteHook,
  type AgentHarnessAttemptResult,
  type AgentHarnessV2,
  type AgentMessage,
  type AnyAgentTool,
  type EmbeddedRunAttemptParamsV2,
  type TranscriptEntryAnchor,
} from "../adapters/openclaw-sdk.js";
import { HOST_TOOL_NAMES } from "../host-adapter.js";
import type { CordisBridgeHost, AgentRunResult } from "./cordis-bridge-host.js";
import type { SessionEvent } from "../adapters/dsh-session.js";
import { CordisAgentRunError } from "./agent-error.js";

export type DshAgentHarnessOptions = {
  host: Pick<CordisBridgeHost, 'runHarnessAgent'>;
  timeoutMs: number;
  onRunStarted?: (runId: string, sessionKey: string) => void;
  onRunCompleted?: (result: AgentRunResult) => void;
  onRunEnded?: (runId: string) => void;
  onSupportEvaluated?: (message: string) => void;
};

export type DshHarnessRoute = {
  provider: "deepseek-official";
  model: string;
};

/**
 * Registers DSH as the executor for a prepared OpenClaw turn.
 * OpenClaw keeps the channel, Gateway, session routing, and visible transcript;
 * DSH owns the model/tool loop for the selected turn.
 */
export function createDshAgentHarness(options: DshAgentHarnessOptions): AgentHarnessV2 {
  return {
    id: "dsh",
    label: "DeepSeek Harness (DSH) Agent Runtime",
    autoSelection: { providerIds: [] },
    conversationToolPolicySupport: "exact",
    conversationToolPolicySafeDenyTools: ["exec", "read", "write", "edit", ...HOST_TOOL_NAMES],
    supports(context) {
      const reject = (reason: string, fallbackRuntime?: "openclaw") => {
        options.onSupportEvaluated?.(
          `rejected provider=${context.provider} model=${context.modelId ?? "<empty>"} ` +
          `requestedRuntime=${context.requestedRuntime}: ${reason}`,
        );
        return fallbackRuntime
          ? { supported: false as const, reason, fallbackRuntime }
          : { supported: false as const, reason };
      };
      if (context.requestedRuntime !== "dsh") {
        return reject("DSH must be selected explicitly");
      }
      if (context.provider !== "deepseek") {
        return reject("this adapter currently supports the deepseek provider");
      }
      if (!context.modelId?.trim()) {
        return reject("OpenClaw did not provide a model id for this turn");
      }
      if (context.modelProvider?.requestTransportOverrides === "present") {
        return reject("DSH cannot reproduce authored OpenClaw request transport overrides", "openclaw");
      }
      const compatibleIds = context.modelProvider?.runtimePolicy?.compatibleIds;
      if (compatibleIds && !compatibleIds.includes("dsh")) {
        return reject("the selected model route does not permit DSH");
      }
      return { supported: true, priority: 100 };
    },
    async runAttempt(params) {
      return await runDshAttempt(params, options);
    },
  };
}

async function runDshAttempt(
  params: EmbeddedRunAttemptParamsV2,
  options: DshAgentHarnessOptions,
): Promise<AgentHarnessAttemptResult> {
  params.onExecutionStarted?.();
  options.onRunStarted?.(params.runId, params.sessionKey ?? params.sessionId);
  const hookContext = {
    runId: params.runId,
    jobId: params.jobId,
    agentId: params.agentId,
    sessionKey: params.sessionKey ?? params.sessionId,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    modelProviderId: params.provider,
    modelId: params.modelId,
    trigger: params.trigger,
    // Plugin-private provenance consumed by the Bridge's lifecycle hooks. The
    // public OpenClaw hook context does not yet expose the selected Harness id.
    agentRuntimeId: "dsh",
    ...(params.config ? { config: params.config } : {}),
    ...buildAgentHookContextChannelFields(params),
  };
  // External harness attempts receive the prepared prompt rather than OpenClaw's
  // internal transcript array. Hooks can still correlate capture/recall by the
  // canonical session key and the exact pre-injection prompt below.
  const inputMessages: AgentMessage[] = [];
  const lifetime = new AbortController();
  const assertActive = () => {
    lifetime.signal.throwIfAborted();
    params.abortSignal?.throwIfAborted();
    params.hostCapabilities.assertActive();
  };
  try {
    const sandbox = await resolveSandboxContext({ config: params.config, agentId: params.agentId,
      sessionKey: params.sessionKey, workspaceDir: params.workspaceDir });
    if (sandbox) throw new Error('CoNest Studio DSH Loop does not yet support sandboxed host sessions');
    const route = resolveDshHarnessRoute({
      provider: params.provider,
      modelId: params.modelId,
    });
    assertActive();
    const sessionTarget = params.sessionTarget;
    const sessionEntry = sessionTarget?.storePath && sessionTarget.sessionKey
      ? getSessionEntry({ storePath: sessionTarget.storePath, sessionKey: sessionTarget.sessionKey,
        agentId: sessionTarget.agentId ?? params.agentId, readConsistency: 'latest' })
      : undefined;
    if (sessionEntry && sessionEntry.sessionId !== params.sessionId) throw new Error('The owning OpenClaw session changed');
    // The official host can reset a session while retaining its sessionId.
    // Read the public lifecycle revision; without one, do not reuse history.
    const hostLifecycleRevision = sessionEntry?.lifecycleRevision ?? `attempt:${params.runId}`;
    assertActive();
    const eventBridge = createDshEventBridge(params);
    if (!params.hostCapabilities.createToolSurface) throw new Error("OpenClaw did not provide a bound tool surface");
    const surface = params.hostCapabilities.createToolSurface({
      ...buildEmbeddedAttemptToolRunContext(params),
      config: params.config, agentId: params.agentId, sessionKey: params.sessionKey,
      runSessionKey: params.sessionKey, sessionId: params.sessionId, runId: params.runId,
      workspaceDir: params.workspaceDir, cwd: params.workspaceDir, agentDir: params.agentDir,
      modelProvider: params.provider, modelId: params.modelId,
      abortSignal: params.abortSignal, includeCoreTools: true,
      senderIsOwner: params.senderIsOwner,
    }, { cwd: params.workspaceDir });
    let hostTools: AnyAgentTool[] = [];
    const promptBuild = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: params.prompt,
      // The public SDK calls this builder after ordinary hooks and before the
      // authorized pass. Publish only the final intersection, never a guessed
      // or pre-hook tool list. Do not run memory/prompt hooks a second time.
      developerInstructions: { build({ toolsAllow }) {
        assertActive();
        hostTools = params.disableTools ? [] : applyEmbeddedAttemptToolsAllow(
          applyEmbeddedAttemptToolsAllow(surface, params.toolsAllow), toolsAllow,
        ).filter(tool => tool.name !== "cordis_agent_run")
          .filter(tool => !params.pluginHarnessToolPolicySafeDeniedTools?.includes(tool.name));
        return "";
      } },
      messages: inputMessages,
      ctx: hookContext,
      bootstrapContextRunKind: params.bootstrapContextRunKind,
      toolAuthority: {
        fingerprint: params.toolAuthorityFingerprint,
        activeToolNames: () => hostTools.map(tool => tool.name),
        assertActive,
      },
    });
    const boundTools = hostTools.map(tool => ({ ...tool, async execute(callId: string, args: unknown, signal?: AbortSignal) {
      const startedAt = Date.now();
      try {
        assertActive();
        const callSignal = AbortSignal.any([lifetime.signal, ...params.abortSignal ? [params.abortSignal] : [], ...signal ? [signal] : []]);
        callSignal.throwIfAborted();
        // createToolSurface already wraps the real before-tool hook, including
        // run/requester binding. Forward completion once through the public SDK.
        const result = await tool.execute(callId, args, callSignal);
        assertActive();
        await runAgentHarnessAfterToolCallHook({ ...hookContext, toolName: tool.name, toolCallId: callId,
          startArgs: args as Record<string, unknown>, result, startedAt });
        return result;
      } catch (error) {
        await runAgentHarnessAfterToolCallHook({ ...hookContext, toolName: tool.name, toolCallId: callId,
          startArgs: args as Record<string, unknown>, error: String(error), startedAt });
        throw error;
      }
    } }));
    const result = await options.host.runHarnessAgent({
      hostTools: params.disableTools ? [] : boundTools,
      task: promptBuild.prompt,
      sessionKey: params.sessionKey ?? params.sessionId,
      hostSessionId: params.sessionId,
      hostAgentId: params.agentId,
      hostLifecycleRevision,
      provider: route.provider,
      model: route.model,
      timeoutMs: Math.min(params.timeoutMs, options.timeoutMs),
      signal: params.abortSignal,
      onEvent: eventBridge.onEvent,
      images: params.images?.map((image) => ({ data: image.data, mimeType: image.mimeType })),
      toolPolicy: {
        allow: promptBuild.toolsAllow ?? params.toolsAllow,
        deny: params.pluginHarnessToolPolicySafeDeniedTools,
      },
      approvalRequester: async (request) => {
        const timeoutMs = Math.min(params.timeoutMs, options.timeoutMs);
        const submitted = await params.hostCapabilities.requestApproval({
          title: `DSH ${request.toolName} requires approval`,
          description: request.reason ?? `Approve DSH tool ${request.toolName}`,
          severity: "warning",
          toolName: request.toolName,
          toolCallId: request.callId,
          allowedDecisions: ["allow-once", "allow-always", "deny"],
          timeoutMs,
        });
        if (submitted?.decision === "allow-once" || submitted?.decision === "allow-always") {
          return "allowed-once";
        }
        if (submitted?.decision === "deny") return "rejected";
        if (!submitted?.id) return params.abortSignal?.aborted ? "cancelled" : "unavailable";
        const decided = await params.hostCapabilities.waitForApproval({
          approvalId: submitted.id,
          timeoutMs,
          signal: params.abortSignal,
        });
        if (decided?.decision === "allow-once" || decided?.decision === "allow-always") {
          return "allowed-once";
        }
        if (decided?.decision === "deny") return "rejected";
        return decided?.terminalReason === "run-aborted" || params.abortSignal?.aborted
          ? "cancelled"
          : "unavailable";
      },
    });
    if (result.finalText && !eventBridge.assistantTextStreamed()) {
      await params.onPartialReply?.({ text: result.finalText });
    }
    options.onRunCompleted?.(result);

    const assistant = createAssistantMessage(params, result);
    const transcript = await persistDshAssistantTranscript(params, assistant);
    const toolMetas = result.toolCalls.map((call) => {
      const toolResult = result.toolResults.find((candidate) => candidate.callId === call.callId);
      const replaySafe = isReadOnlyDshTool(call.name);
      return {
        toolName: call.name,
        toolCallId: call.callId,
        replaySafe,
        isError: toolResult?.isError === true,
      };
    });
    const hadPotentialSideEffects = toolMetas.some((meta) => !meta.replaySafe);

    const attemptResult = {
      terminal: { kind: "ok" },
      sessionIdUsed: params.sessionId,
      sessionFileUsed: params.sessionFile,
      messagesSnapshot: [assistant] satisfies AgentMessage[],
      assistantTexts: result.finalText ? [result.finalText] : [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptCompletedAssistant: assistant,
      toolMetas,
      didSendViaMessagingTool: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      cloudCodeAssistFormatError: false,
      toolMediaUrls: result.finalMediaUrls,
      hostOwnedToolMediaUrls: result.finalMediaUrls,
      hasToolMediaBlockReply: result.finalMediaUrls.length > 0,
      replayMetadata: {
        hadPotentialSideEffects,
        replaySafe: !hadPotentialSideEffects,
      },
      currentAttemptReplayMetadata: {
        hadPotentialSideEffects,
        replaySafe: !hadPotentialSideEffects,
      },
      attemptUsage: {
        input: result.usage.inputTokens,
        output: result.usage.outputTokens,
        cacheRead: result.usage.cacheReadTokens,
        cacheWrite: result.usage.cacheWriteTokens,
        reasoningTokens: result.usage.reasoningTokens,
        total: totalUsage(result),
      },
      itemLifecycle: {
        startedCount: result.toolCalls.length,
        completedCount: result.toolCalls.length,
        activeCount: 0,
      },
      modelIterations: result.modelIterations,
      ...(transcript.owned
        ? {
            assistantTranscriptOwned: true,
            ...(transcript.idempotencyKey
              ? { assistantTranscriptIdempotencyKey: transcript.idempotencyKey }
              : {}),
            ...(transcript.terminalAnchor ? { terminalAnchor: transcript.terminalAnchor } : {}),
          }
        : {}),
    } satisfies AgentHarnessAttemptResult;
    await awaitAgentHarnessAgentEndHook({
      event: {
        messages: [...inputMessages, assistant],
        success: true,
      },
      ctx: hookContext,
    });
    return attemptResult;
  } catch (error) {
    await awaitAgentHarnessAgentEndHook({
      event: {
        messages: inputMessages,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      ctx: hookContext,
    });
    const aborted = params.abortSignal?.aborted === true ||
      (error instanceof CordisAgentRunError && error.kind === "aborted");
    const timedOut = error instanceof CordisAgentRunError && error.kind === "timeout";
    return {
      terminal: timedOut
        ? {
            kind: "timeout",
            phase: "prompt",
            source: "runtime",
            aborted: true,
            failure: { source: "prompt", error },
          }
        : aborted
        ? { kind: "aborted", source: "external", failure: { source: "prompt", error } }
        : { kind: "failed", source: "prompt", error },
      sessionIdUsed: params.sessionId,
      sessionFileUsed: params.sessionFile,
      messagesSnapshot: [],
      assistantTexts: [],
      lastAssistant: undefined,
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: undefined,
      toolMetas: [],
      didSendViaMessagingTool: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      cloudCodeAssistFormatError: false,
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    };
  } finally {
    lifetime.abort(new Error("DSH harness attempt ended"));
    options.onRunEnded?.(params.runId);
  }
}

type DshTranscriptPersistence = {
  owned: boolean;
  idempotencyKey?: string;
  terminalAnchor?: TranscriptEntryAnchor;
};

type DshTranscriptAssistant = Extract<AgentMessage, { role: "assistant" }> & {
  idempotencyKey: string;
};

/**
 * DSH owns execution but OpenClaw owns the visible conversation. Persist the
 * canonical assistant turn through OpenClaw's public plugin transcript API so
 * Web/CLI history remains complete without any DSH-specific Core behavior.
 */
async function persistDshAssistantTranscript(
  params: EmbeddedRunAttemptParamsV2,
  assistant: Extract<AgentMessage, { role: "assistant" }>,
): Promise<DshTranscriptPersistence> {
  const sessionKey = params.sessionTarget?.sessionKey ?? params.sessionKey ?? params.sessionId;
  const sessionId = params.sessionTarget?.sessionId ?? params.sessionId;
  const storePath = params.sessionTarget?.storePath;
  if (!sessionKey || !sessionId || !storePath) {
    return { owned: false };
  }

  const idempotencyKey = `dsh:${params.runId}:assistant`;
  const message: DshTranscriptAssistant = {
    ...assistant,
    idempotencyKey,
  };
  const target = {
    ...(params.sessionTarget?.agentId ?? params.agentId
      ? { agentId: params.sessionTarget?.agentId ?? params.agentId }
      : {}),
    sessionId,
    sessionKey,
    storePath,
  };
  const outcome = await appendSessionTranscriptMessageByIdentityStrict({
    ...target,
    ...(params.config ? { config: params.config } : {}),
    ...(params.workspaceDir ? { cwd: params.workspaceDir } : {}),
    eventId: `${params.runId}:assistant`,
    idempotencyLookup: "scan",
    message,
    prepareMessageAfterIdempotencyCheck: () => {
      const hooked = runAgentHarnessBeforeMessageWriteHook({
        agentId: params.agentId,
        message: structuredClone(message),
        sessionKey,
      });
      if (!hooked) return undefined;
      if (hooked.role !== "assistant") {
        throw new CordisAgentRunError(
          "failed",
          "OpenClaw before_message_write changed the DSH assistant turn role",
        );
      }
      const projected = projectAgentHarnessTranscriptMessageForDisplay({
        hidden: params.trigger === "memory",
        message: { ...hooked, idempotencyKey } satisfies DshTranscriptAssistant,
      });
      if (projected.role !== "assistant") {
        throw new CordisAgentRunError(
          "failed",
          "OpenClaw display projection changed the DSH assistant turn role",
        );
      }
      return { ...projected, idempotencyKey } satisfies DshTranscriptAssistant;
    },
  });

  if (outcome.kind === "rejected") {
    throw new CordisAgentRunError(
      "failed",
      "OpenClaw session changed before the DSH assistant turn could be persisted",
    );
  }
  if (outcome.kind === "suppressed") {
    return { owned: true };
  }
  if (outcome.result.appended) {
    await publishSessionTranscriptUpdateByIdentity(target);
  }
  return {
    owned: true,
    idempotencyKey,
    terminalAnchor: outcome.result.anchor,
  };
}

/**
 * Translate OpenClaw's logical model identity into the provider id understood by
 * the DSH LLM adapter. The model id always comes from the prepared OpenClaw turn;
 * the bridge must never substitute a plugin-configured model.
 */
export function resolveDshHarnessRoute(input: {
  provider: string;
  modelId?: string;
}): DshHarnessRoute {
  const provider = input.provider.trim().toLowerCase();
  const model = input.modelId?.trim();
  if (!model) {
    throw new CordisAgentRunError("failed", "OpenClaw did not provide a model id for the DSH turn");
  }
  if (provider !== "deepseek") {
    throw new CordisAgentRunError(
      "failed",
      `OpenClaw provider ${input.provider || "<empty>"} has no installed DSH LLM adapter`,
    );
  }
  return { provider: "deepseek-official", model };
}

function createDshEventBridge(params: EmbeddedRunAttemptParamsV2): {
  onEvent: (event: SessionEvent) => Promise<void>;
  assistantTextStreamed: () => boolean;
} {
  let assistantText = "";
  let reasoningText = "";
  const toolCalls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  return {
    assistantTextStreamed: () => assistantText.length > 0,
    async onEvent(event) {
      // DSH <=0.1.1 published live assistant/chunk events. Newer releases keep
      // the exact stream inside the terminal assistant event, so the caller's
      // final-result fallback publishes the completed text instead.
      const legacyStreamEvent = event as unknown as {
        type: string;
        data?: { chunk?: { type?: string; text?: string } };
      };
      if (legacyStreamEvent.type === "assistant/chunk" && legacyStreamEvent.data?.chunk) {
        const chunk = legacyStreamEvent.data.chunk;
        if (chunk.type === "text-delta") {
          assistantText += chunk.text ?? "";
          await params.onAgentEvent?.({
            stream: "assistant",
            data: { text: assistantText, delta: chunk.text ?? "" },
            sessionKey: params.sessionKey,
          });
          await params.onPartialReply?.({ text: assistantText, delta: chunk.text ?? "" });
        } else if (chunk.type === "reasoning-delta") {
          reasoningText += chunk.text ?? "";
          await params.onReasoningStream?.({ text: reasoningText, isReasoning: true });
          await params.onAgentEvent?.({
            stream: "reasoning",
            data: { text: reasoningText, delta: chunk.text ?? "" },
            sessionKey: params.sessionKey,
          });
        }
        return;
      }
      if (event.type === "tool/call") {
        const argumentsValue = parseArguments(event.data.arguments);
        toolCalls.set(event.data.callId, { name: event.data.name, arguments: argumentsValue });
        await params.onAgentEvent?.({
          stream: "tool",
          data: {
            phase: "start",
            name: event.data.name,
            toolCallId: event.data.callId,
            args: argumentsValue,
          },
          sessionKey: params.sessionKey,
        });
        return;
      }
      if (event.type === "tool/result") {
        for (const block of event.data.message.content) {
          const call = toolCalls.get(block.toolCallId);
          if (!call) continue;
          const replaySafe = isReadOnlyDshTool(call.name);
          params.observeToolTerminal?.({
            toolCallId: block.toolCallId,
            toolName: call.name,
            arguments: call.arguments,
            executionStarted: true,
            outcome: block.isError ? "failure" : "success",
            nativeMutation: { mutatingAction: !replaySafe, replaySafe },
          });
          await params.onAgentEvent?.({
            stream: "tool",
            data: {
              phase: "result",
              name: call.name,
              toolCallId: block.toolCallId,
              status: block.isError ? "failed" : "completed",
              isError: block.isError === true,
              output: messageText(block.content),
            },
            sessionKey: params.sessionKey,
          });
        }
      }
    },
  };
}

function createAssistantMessage(
  params: EmbeddedRunAttemptParamsV2,
  result: AgentRunResult,
): Extract<AgentMessage, { role: "assistant" }> {
  const totalTokens = totalUsage(result);
  return {
    role: "assistant",
    content: result.finalContent,
    api: "openai-completions",
    provider: params.provider,
    model: params.modelId,
    usage: {
      input: result.usage.inputTokens,
      output: result.usage.outputTokens,
      cacheRead: result.usage.cacheReadTokens,
      cacheWrite: result.usage.cacheWriteTokens,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function messageText(content: readonly unknown[]): string {
  return content.flatMap((block) =>
    block && typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
      ? [(block as { text: string }).text]
      : [],
  ).join("");
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { raw: value };
  }
}

function isReadOnlyDshTool(name: string): boolean {
  return /(?:^|__)(?:read|glob|grep|search_nodes|open_nodes|read_graph)$/.test(name);
}

function totalUsage(result: AgentRunResult): number {
  return result.usage.inputTokens + result.usage.outputTokens +
    result.usage.cacheReadTokens + result.usage.cacheWriteTokens;
}

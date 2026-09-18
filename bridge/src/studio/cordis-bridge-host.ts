import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { CallId, createUserMessage, type ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startComposition, type RunningComposition } from "./composition.js";
import { generatedComposition } from "./generated/composition.generated.js";

type BridgeState = "stopped" | "starting" | "ready" | "stopping";

export type AgentRunResult = {
  sessionId: string;
  provider: string;
  model: string;
  finalText: string;
  finalContent: Array<
    { type: "text"; text: string }
  >;
  finalMediaUrls: string[];
  turnReason: unknown;
  toolCalls: Array<{ callId: string; name: string; arguments: string }>;
  toolResults: Array<{ callId: string; text: string; isError: boolean }>;
  eventCount: number;
  modelIterations: number;
  sessionReused: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  };
};

export class CordisAgentRunError extends Error {
  constructor(
    public readonly kind: "aborted" | "failed" | "timeout",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CordisAgentRunError";
  }
}

export type AutomaticMemoryRecord = {
  entityName: string;
  observations: string[];
};

export type HarnessImage = { data: string; mimeType: string; name?: string };
export type HarnessToolPolicy = { allow?: readonly string[]; deny?: readonly string[] };
export type HarnessApprovalRequester = (request: ApprovalRequest) => Promise<ApprovalOutcome>;

/** Owns the Cordis container behind one OpenClaw plugin service generation. */
export class CordisBridgeHost {
  private state: BridgeState = "stopped";
  private composition: RunningComposition | undefined;
  private transition: Promise<void> | undefined;
  private workspaceRoot: string | undefined;
  private readonly agents = new Map<string, Agent>();
  private readonly harnessAgents = new Map<string, Promise<AgentHandle>>();
  private readonly coldResumedHandles = new WeakSet<AgentHandle>();
  private automaticMemoryQueue: Promise<void> = Promise.resolve();

  status(): BridgeState {
    return this.state;
  }

  start(options: {
    workspaceRoot: string;
    memoryFilePath?: string;
    sessionPersistenceRoot?: string;
    enableBridgeProofAdapter?: boolean;
  }): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.state === "starting" && this.transition) return this.transition;
    if (this.state !== "stopped") {
      return Promise.reject(new Error(`Cordis bridge cannot start while ${this.state}`));
    }

    this.state = "starting";
    const transition = this.boot(options);
    this.transition = transition;
    return transition;
  }

  private async boot(options: {
    workspaceRoot: string;
    memoryFilePath?: string;
    sessionPersistenceRoot?: string;
    enableBridgeProofAdapter?: boolean;
  }): Promise<void> {
    try {
      const composition = await startComposition(options);
      const actualNames = composition.context.tools.schemas().map((tool) => tool.name);
      const compiledNames = generatedComposition.tools.map((tool) => tool.dshName);
      if (JSON.stringify(actualNames) !== JSON.stringify(compiledNames)) {
        await composition.dispose();
        throw new Error(
          `compiled DSH tool catalog is stale: generated=${compiledNames.join(",")} runtime=${actualNames.join(",")}`,
        );
      }
      this.composition = composition;
      this.workspaceRoot = options.workspaceRoot;
      this.state = "ready";
    } catch (error) {
      this.state = "stopped";
      throw error;
    } finally {
      this.transition = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    if (this.state === "starting" && this.transition) await this.transition;
    if (this.state !== "ready") return;

    this.state = "stopping";
    const composition = this.composition;
    const harnessAgents = [...this.harnessAgents.values()];
    this.harnessAgents.clear();
    try {
      const handles = await Promise.allSettled(harnessAgents);
      await Promise.allSettled(
        handles.flatMap((result) => result.status === "fulfilled" ? [result.value.dispose()] : []),
      );
      await composition?.dispose();
    } finally {
      this.composition = undefined;
      this.workspaceRoot = undefined;
      this.agents.clear();
      this.state = "stopped";
    }
  }

  async execute(
    toolCallId: string,
    name: string,
    params: unknown,
    sessionKey: string,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (this.state !== "ready" || !this.composition) {
      throw new Error(`Cordis bridge is ${this.state}; the OpenClaw plugin service is not ready`);
    }
    return this.composition.context.tools.execute({
      callId: CallId(toolCallId),
      name,
      arguments: params,
      agent: this.agentFor(sessionKey),
      signal: signal ?? new AbortController().signal,
    });
  }

  async runAgent(options: {
    task: string;
    sessionKey: string;
    provider: string;
    model: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onEvent?: (event: SessionEvent) => void | Promise<void>;
  }): Promise<AgentRunResult> {
    if (this.state !== "ready" || !this.composition || !this.workspaceRoot) {
      throw new Error(`Cordis bridge is ${this.state}; the OpenClaw plugin service is not ready`);
    }

    const context = this.composition.context;
    const id = SessionId(`openclaw-delegate:${options.sessionKey}:${crypto.randomUUID()}`);
    const handle = await context.agents.create({
      sessionId: id,
      meta: { cwd: this.workspaceRoot },
      agentOptions: { provider: options.provider, model: options.model, maxTokens: 2048 },
      signal: options.signal,
    });
    return await this.executeAgentTurn(handle, options, {
      sessionReused: false,
      disposeAfterTurn: true,
    });
  }

  async runHarnessAgent(options: {
    task: string;
    sessionKey: string;
    provider: string;
    model: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onEvent?: (event: SessionEvent) => void | Promise<void>;
    images?: readonly HarnessImage[];
    toolPolicy?: HarnessToolPolicy;
    hostTools?: AnyAgentTool[];
    approvalRequester?: HarnessApprovalRequester;
  }): Promise<AgentRunResult> {
    if (this.state !== "ready" || !this.composition || !this.workspaceRoot) {
      throw new Error(`Cordis bridge is ${this.state}; the OpenClaw plugin service is not ready`);
    }
    const bindingKey = `${options.sessionKey}\u0000${options.provider}\u0000${options.model}`;
    let handlePromise = this.harnessAgents.get(bindingKey);
    const sessionReused = handlePromise !== undefined;
    if (!handlePromise) {
      handlePromise = this.openHarnessAgent(bindingKey, options);
      this.harnessAgents.set(bindingKey, handlePromise);
      void handlePromise.catch(() => {
        if (this.harnessAgents.get(bindingKey) === handlePromise) {
          this.harnessAgents.delete(bindingKey);
        }
      });
    }
    const handle = await handlePromise;
    if (handle.agent.status !== "idle") {
      throw new CordisAgentRunError("failed", `DSH session ${handle.agent.id} is already running`);
    }
    return await this.executeAgentTurn(handle, options, {
      sessionReused,
      disposeAfterTurn: false,
    });
  }

  private async openHarnessAgent(
    bindingKey: string,
    options: { provider: string; model: string; signal?: AbortSignal },
  ): Promise<AgentHandle> {
    if (!this.composition || !this.workspaceRoot) throw new Error("Cordis bridge is not ready");
    const id = SessionId(
      // v2 intentionally leaves sessions produced by the former dual-module
      // tool-scheduler bundle behind. A tool call could be persisted without
      // its matching result, which is not safe to replay into a model request.
      `openclaw-harness-v2-${createHash("sha256").update(bindingKey).digest("hex").slice(0, 32)}`,
    );
    const common = {
      agentOptions: { provider: options.provider, model: options.model, maxTokens: 2048 },
      signal: options.signal,
      // Rebuild and validate the scoped tool view for both cold resume and
      // fresh creation. Persisted sessions contain transcript state, not live
      // MCP transport objects; the setup callback is the lifecycle boundary
      // where the current composition must be reattached.
      setup: (agentCtx: { tools: { schemas(): Array<{ name: string }> } }) => {
        const names = new Set(agentCtx.tools.schemas().map((tool) => tool.name));
        const required = ["bash", "mcp__reference_memory__search_nodes"];
        const missing = required.filter((name) => !names.has(name));
        if (missing.length > 0) {
          throw new Error(`DSH Agent setup missing live tools: ${missing.join(", ")}`);
        }
      },
    };
    try {
      const handle = await this.composition.context.agents.resume({ resumeSessionId: id, ...common });
      this.coldResumedHandles.add(handle);
      return handle;
    } catch (error) {
      if (!/session .* not found/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      return await this.composition.context.agents.create({
        sessionId: id,
        meta: { cwd: this.workspaceRoot },
        ...common,
      });
    }
  }

  private async executeAgentTurn(
    handle: AgentHandle,
    options: {
      task: string;
      sessionKey: string;
      provider: string;
      model: string;
      timeoutMs: number;
      signal?: AbortSignal;
      onEvent?: (event: SessionEvent) => void | Promise<void>;
      images?: readonly HarnessImage[];
      toolPolicy?: HarnessToolPolicy;
    hostTools?: AnyAgentTool[];
      approvalRequester?: HarnessApprovalRequester;
    },
    lifecycle: { sessionReused: boolean; disposeAfterTurn: boolean },
  ): Promise<AgentRunResult> {
    if (!this.composition || !this.workspaceRoot) throw new Error("Cordis bridge is not ready");
    const agent = handle.agent;
    const firstEventIndex = agent.session.events.length;
    const coldResumeTurn = this.coldResumedHandles.delete(handle);
    let timedOut = false;
    let eventBridgeError: unknown;
    let eventQueue = Promise.resolve();
    const disposeEventListener = options.onEvent && !coldResumeTurn
      ? agent.ctx.on("session/event", (session, event) => {
          if (session !== agent.session) return;
          eventQueue = eventQueue
            .then(() => options.onEvent?.(event))
            .catch((error) => { eventBridgeError ??= error; });
        })
      : undefined;
    // Hide every unbound global tool: the admitted OpenClaw surface is the authority.
    const releaseToolRestriction = options.hostTools
      ? agent.ctx.tools.restrict({ allow: [] })
      : applyHarnessToolPolicy(agent, options.toolPolicy);
    const hostToolDisposers: Array<() => void> = [];
    try {
      for (const tool of options.hostTools ?? []) hostToolDisposers.push(agent.ctx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: JSON.parse(JSON.stringify(tool.parameters)),
        output: { schema: {}, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
        async execute(args, execution) {
          const result = await tool.execute(String(execution.callId), args, execution.signal);
          if ((result as { isError?: boolean }).isError) throw new Error(JSON.stringify(result.content));
          return JSON.parse(JSON.stringify(result));
        },
      }));
    } catch (error) {
      for (const dispose of hostToolDisposers.reverse()) dispose();
      releaseToolRestriction?.();
      throw error;
    }
    const releaseApprovalBridge = agent.ctx.on(
      "approval/request",
      async (request, next) => options.approvalRequester
        ? await options.approvalRequester(request)
        : await next(),
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      agent.cancel({ kind: "hook", reason: "OpenClaw DSH Agent Harness timeout" });
    }, options.timeoutMs);
    const onAbort = (): void => agent.cancel({ kind: "parent" });
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const content: ContentBlock[] = [{ type: "text", text: options.task }];
      for (const image of options.images ?? []) {
        if (!isDshImageMediaType(image.mimeType)) {
          throw new CordisAgentRunError("failed", `unsupported image MIME type: ${image.mimeType}`);
        }
        const attachment = await this.composition.context.attachments.saveImage({
          data: Buffer.from(image.data, "base64"),
          mediaType: image.mimeType,
          name: image.name,
        });
        content.push({ type: "image", attachment });
      }
      agent.followup(createUserMessage({
        content,
        source: { kind: "user" },
      }));
      await agent.whenIdle();
      await this.composition.context.sessions.flush(agent.session);
      await eventQueue;
      if (eventBridgeError) {
        throw new CordisAgentRunError("failed", "OpenClaw event bridge rejected a DSH event", {
          cause: eventBridgeError,
        });
      }
      const events = agent.session.events.slice(firstEventIndex);
      const turnEnd = events.findLast((event) => event.type === "turn/end");
      if (timedOut) {
        throw new CordisAgentRunError("timeout", "DSH Agent Loop exceeded the OpenClaw turn timeout");
      }
      if (options.signal?.aborted) {
        throw new CordisAgentRunError("aborted", "DSH Agent Loop was cancelled by OpenClaw");
      }
      if (turnEnd?.type === "turn/end" && turnEnd.data.reason.kind === "error") {
        throw new CordisAgentRunError(
          "failed",
          `Cordis Agent Loop failed: ${turnEnd.data.reason.error.code}: ${turnEnd.data.reason.error.message}`,
        );
      }
      if (turnEnd?.type === "turn/end" && turnEnd.data.reason.kind !== "completed") {
        throw new CordisAgentRunError(
          "failed",
          `Cordis Agent Loop ended with ${turnEnd.data.reason.kind}`,
        );
      }
      return await summarizeAgentRun(
        this.composition.context,
        this.workspaceRoot!,
        agent.id,
        options.provider,
        options.model,
        events,
        lifecycle.sessionReused,
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      disposeEventListener?.();
      for (const dispose of hostToolDisposers.reverse()) dispose();
      releaseToolRestriction?.();
      releaseApprovalBridge();
      if (lifecycle.disposeAfterTurn) await handle.dispose();
    }
  }

  async recallAutomaticMemory(entityName: string): Promise<AutomaticMemoryRecord> {
    return await this.runAutomaticMemoryOperation(async () => {
      const result = await this.execute(
        `automatic-memory-open-${crypto.randomUUID()}`,
        "mcp__reference_memory__open_nodes",
        { names: [entityName] },
        `automatic-memory:${entityName}`,
      );
      assertToolSucceeded(result, "open_nodes");
      const entities = readStructuredEntities(result.value);
      const entity = entities.find((candidate) => candidate.name === entityName);
      return { entityName, observations: entity?.observations ?? [] };
    });
  }

  async storeAutomaticMemory(entityName: string, observation: string): Promise<{
    action: "created" | "added" | "already-present";
  }> {
    return await this.runAutomaticMemoryOperation(async () => {
      const sessionKey = `automatic-memory:${entityName}`;
      const existingResult = await this.execute(
        `automatic-memory-open-${crypto.randomUUID()}`,
        "mcp__reference_memory__open_nodes",
        { names: [entityName] },
        sessionKey,
      );
      assertToolSucceeded(existingResult, "open_nodes");
      const entity = readStructuredEntities(existingResult.value)
        .find((candidate) => candidate.name === entityName);
      if (!entity) {
        const createResult = await this.execute(
          `automatic-memory-create-${crypto.randomUUID()}`,
          "mcp__reference_memory__create_entities",
          {
            entities: [{
              name: entityName,
              entityType: "openclaw-automatic-memory",
              observations: [observation],
            }],
          },
          sessionKey,
        );
        assertToolSucceeded(createResult, "create_entities");
        return { action: "created" };
      }
      if (entity.observations.includes(observation)) return { action: "already-present" };
      const addResult = await this.execute(
        `automatic-memory-add-${crypto.randomUUID()}`,
        "mcp__reference_memory__add_observations",
        { observations: [{ entityName, contents: [observation] }] },
        sessionKey,
      );
      assertToolSucceeded(addResult, "add_observations");
      return { action: "added" };
    });
  }

  private async runAutomaticMemoryOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.automaticMemoryQueue.then(operation, operation);
    this.automaticMemoryQueue = result.then(() => undefined, () => undefined);
    return await result;
  }

  /** Give DSH policies a stable per-OpenClaw-session owner and workspace identity. */
  private agentFor(sessionKey: string): Agent {
    const existing = this.agents.get(sessionKey);
    if (existing) return existing;
    if (!this.composition || !this.workspaceRoot) {
      throw new Error("Cordis bridge has no active composition");
    }

    const id = SessionId(`openclaw:${sessionKey}`);
    const session = this.composition.context.sessions.create(id, {
      meta: { cwd: this.workspaceRoot },
    });
    const agent = {
      id,
      options: {},
      session,
      ctx: this.composition.context,
      status: "idle",
    } as Agent;
    this.agents.set(sessionKey, agent);
    return agent;
  }
}

function applyHarnessToolPolicy(agent: Agent, policy?: HarnessToolPolicy): (() => void) | undefined {
  if (!policy || (policy.allow === undefined && (policy.deny?.length ?? 0) === 0)) return undefined;
  const known = new Set(agent.ctx.tools.schemas().map((tool) => tool.name));
  const allow = policy.allow?.flatMap(mapOpenClawToolName).filter((name) => known.has(name));
  const deny = policy.deny?.flatMap(mapOpenClawToolName).filter((name) => known.has(name));
  return agent.ctx.tools.restrict({
    ...(allow !== undefined ? { allow: [...new Set(allow)] } : {}),
    ...(deny && deny.length > 0 ? { deny: [...new Set(deny)] } : {}),
  });
}

function mapOpenClawToolName(name: string): string[] {
  switch (name.trim().toLowerCase()) {
    case "*": return generatedComposition.tools.map((tool) => tool.dshName);
    case "exec":
    case "bash": return ["bash"];
    case "read": return ["read"];
    case "write": return ["write"];
    case "edit": return ["edit"];
    case "glob": return ["glob"];
    case "grep": return ["grep"];
    default: return [name];
  }
}

function isDshImageMediaType(value: string): value is "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}

type StructuredMemoryEntity = {
  name: string;
  observations: string[];
};

function readStructuredEntities(value: unknown): StructuredMemoryEntity[] {
  const structuredContent = value && typeof value === "object"
    ? (value as { structuredContent?: unknown }).structuredContent
    : undefined;
  const entities = structuredContent && typeof structuredContent === "object"
    ? (structuredContent as { entities?: unknown }).entities
    : undefined;
  if (!Array.isArray(entities)) return [];
  return entities.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const name = (candidate as { name?: unknown }).name;
    const observations = (candidate as { observations?: unknown }).observations;
    if (typeof name !== "string" || !Array.isArray(observations)) return [];
    return [{ name, observations: observations.filter((item): item is string => typeof item === "string") }];
  });
}

function assertToolSucceeded(result: ToolExecutionResult, operation: string): void {
  if (!result.isError) return;
  const message = result.content
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join("\n");
  // Memory tool failures are non-fatal: log a warning and continue the loop
  // rather than aborting the entire agent run. A failed memory recall should
  // not prevent the task from completing with the tools that did succeed.
  console.warn(`[dsh-bridge] DSH automatic memory ${operation} failed (non-fatal): ${message || "unknown error"}`);
}

function messageText(content: readonly unknown[]): string {
  return content
    .flatMap((block) =>
      Boolean(block) && typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : [],
    )
    .join("");
}

async function summarizeAgentRun(
  context: RunningComposition["context"],
  workspaceRoot: string,
  id: SessionId,
  provider: string,
  model: string,
  events: SessionEvent[],
  sessionReused: boolean,
): Promise<AgentRunResult> {
  const assistant = events.findLast((event) => event.type === "assistant/message");
  const turnEnd = events.findLast((event) => event.type === "turn/end");
  const finalContent: AgentRunResult["finalContent"] = [];
  const finalMediaUrls: string[] = [];
  if (assistant?.type === "assistant/message") {
    for (const block of assistant.data.message.content) {
      if (block.type === "text") finalContent.push({ type: "text", text: block.text });
      if (block.type === "image") {
        const stored = await context.attachments.readImage(block.attachment);
        const mediaDir = path.join(workspaceRoot, ".dsh", "openclaw-media");
        await mkdir(mediaDir, { recursive: true });
        const mediaPath = path.join(
          mediaDir,
          `${String(stored.ref.attachmentId).replace(/[^A-Za-z0-9._-]/g, "_")}.${imageExtension(stored.ref.mediaType)}`,
        );
        await writeFile(mediaPath, stored.data);
        finalMediaUrls.push(mediaPath);
      }
    }
  }
  return {
    sessionId: id,
    provider,
    model,
    finalText:
      assistant?.type === "assistant/message" ? messageText(assistant.data.message.content) : "",
    finalContent,
    finalMediaUrls,
    turnReason: turnEnd?.type === "turn/end" ? turnEnd.data.reason : undefined,
    toolCalls: events.flatMap((event) =>
      event.type === "tool/call"
        ? [{ callId: event.data.callId, name: event.data.name, arguments: event.data.arguments }]
        : [],
    ),
    toolResults: events.flatMap((event) =>
      event.type === "tool/result"
        ? event.data.message.content.map((block) => ({
            callId: block.toolCallId,
            text: messageText(block.content),
            isError: block.isError === true,
          }))
        : [],
    ),
    eventCount: events.length,
    modelIterations: events.filter((event) => event.type === "assistant/message").length,
    sessionReused,
    usage: events.reduce<AgentRunResult["usage"]>((usage, event) => {
      if (event.type !== "assistant/message" || !event.data.usage) return usage;
      usage.inputTokens += event.data.usage.inputTokens;
      usage.outputTokens += event.data.usage.outputTokens;
      usage.cacheReadTokens += event.data.usage.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += event.data.usage.cacheWriteTokens ?? 0;
      usage.reasoningTokens += event.data.usage.reasoningTokens ?? 0;
      return usage;
    }, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    }),
  };
}

function imageExtension(mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"): string {
  return mediaType === "image/jpeg" ? "jpg" : mediaType.slice("image/".length);
}

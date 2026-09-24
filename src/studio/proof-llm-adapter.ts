import {
  LlmAdapter,
  type ContentBlock,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "../adapters/dsh-llm.js";
import type { CordisContext } from "../adapters/dsh-cordis.js";
import { ToolCallId } from "../adapters/dsh-tools.js";

const PROVIDER = "bridge-proof";

function textFromBlocks(blocks: readonly unknown[]): string {
  return blocks
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const candidate = block as { type?: unknown; text?: unknown; content?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string") return [candidate.text];
      if (candidate.type === "tool-result" && Array.isArray(candidate.content)) {
        return [textFromBlocks(candidate.content)];
      }
      return [];
    })
    .join("");
}

function finalResponse(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: text.length } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

function toolResponse(name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(`bridge-proof-${crypto.randomUUID()}`);
  const argumentsJson = JSON.stringify(args);
  return [
    { type: "block-start", index: 0, blockType: "tool-call" },
    {
      type: "tool-call-delta",
      index: 0,
      id: callId,
      name,
      argumentsDelta: argumentsJson,
    },
    {
      type: "block-end",
      index: 0,
      block: { type: "tool-call", id: callId, name, arguments: argumentsJson },
    },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 8 } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
}

function imageResponse(attachment: Extract<ContentBlock, { type: "image" }>["attachment"]): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "image" },
    { type: "block-end", index: 0, block: { type: "image", attachment } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 1 } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

/**
 * Deterministic adapter used only by the evidence suite. It drives the real
 * DSH Agent Loop and real tools without pretending to be a production model.
 */
export class BridgeProofAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = options.messages as readonly {
      role?: string;
      source?: { kind?: string };
      content: readonly unknown[];
    }[];
    const prompt = [...messages]
      .reverse()
      .find((message) => message.role === "user" && message.source?.kind === "user")
      ?.content;
    const task = textFromBlocks(prompt ?? []);
    const hasImage = (prompt ?? []).some((block) =>
      Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "image");
    const inputImage = (prompt ?? []).find((block): block is Extract<ContentBlock, { type: "image" }> =>
      Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "image");
    const toolResult = [...messages]
      .reverse()
      .flatMap((message) => message.content)
      .find((block) =>
        Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "tool-result");

    let chunks: StreamChunk[];
    if (task.startsWith("PROOF:APPROVAL:")) {
      chunks = toolResult
        ? finalResponse(`Approval result: ${textFromBlocks([toolResult]).trim()}`)
        : toolResponse("bash", {
            command: "printf DSH_APPROVAL_OK",
            description: "Validate OpenClaw approval bridge",
            sandbox_permissions: "danger-full-access",
            justification: "Run the approval bridge validation command.",
          });
    } else if (task.startsWith("PROOF:IMAGE_OUTPUT:") && inputImage) {
      chunks = imageResponse(inputImage.attachment);
    } else if (task.startsWith("PROOF:IMAGE:")) {
      chunks = finalResponse(hasImage ? "DSH_IMAGE_INPUT_OK" : "DSH_IMAGE_INPUT_MISSING");
    } else if (task.startsWith("PROOF:BASH:")) {
      chunks = toolResult
        ? finalResponse(`Cordis Agent Loop completed the delegated shell task: ${textFromBlocks([toolResult]).trim()}`)
        : toolResponse("bash", {
            command: "printf CORDIS_AGENT_LOOP_OK",
            description: "Prove Cordis Agent Loop tool execution",
          });
    } else if (task.startsWith("PROOF:MEMORY_WRITE:")) {
      const [, , name = "bridge-user", observation = "prefers concise evidence"] = task.split(":");
      chunks = toolResult
        ? finalResponse(`Persistent memory stored for ${name}: ${observation}`)
        : toolResponse("dsh_mcp__reference_memory__create_entities", {
            entities: [{ name, entityType: "user-preference", observations: [observation] }],
          });
    } else if (task.startsWith("PROOF:MEMORY_RECALL:")) {
      const query = task.slice("PROOF:MEMORY_RECALL:".length);
      chunks = toolResult
        ? finalResponse(`Persistent memory recalled in a new agent session: ${textFromBlocks([toolResult]).trim()}`)
        : toolResponse("dsh_mcp__reference_memory__search_nodes", { query });
    } else {
      chunks = finalResponse(
        "The bridge-proof adapter only accepts PROOF:IMAGE, PROOF:BASH, PROOF:MEMORY_WRITE, and PROOF:MEMORY_RECALL tasks.",
      );
    }

    for (const chunk of chunks) yield chunk;
  }
}

export function registerBridgeProofAdapter(context: CordisContext): void {
  context.llm.registerAdapter([PROVIDER], new BridgeProofAdapter());
}

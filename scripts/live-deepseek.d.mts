export interface LiveInput {
  messages: unknown[];
  tools: unknown[];
}

export interface LiveCall {
  request: number;
  inputBytes: number;
  startedAt: string;
  status?: number;
  model?: string;
  usage?: Record<string, unknown>;
  elapsedMs?: number;
}

export interface LiveTransport {
  complete(input: LiveInput): Promise<unknown>;
  redact(text: unknown): string;
  report(): {
    provider: string;
    requestedModel: string;
    thinking: string;
    maxRequests: number;
    maxOutputTokens: number;
    maxInputBytes: number;
    inputBytes: number;
    calls: LiveCall[];
  };
}

export function createLiveDeepSeek(
  credentialFile: string,
  fetchResponse?: (url: string, options: RequestInit) => Promise<Response>,
): Promise<LiveTransport>;

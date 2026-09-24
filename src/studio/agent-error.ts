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

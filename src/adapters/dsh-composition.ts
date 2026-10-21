/** Modules loaded together only when the optional full DSH composition starts. */
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import type { Plugin } from '@deepseek-ai/cordis';
export { default as AgentLoop } from '@deepseek-ai/dsh-agent-loop';
export { default as LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
export { default as SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox';
export * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy';
export { default as SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
export { default as LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local';
export { default as SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
export * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
export * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy';
// Older DSH releases export the service class; current releases expose a
// plugin namespace that owns provider teardown and handle lifecycle.
function jsonlPersistencePlugin(): Plugin<JsonlPersistence.Config> {
  const legacy: unknown = Reflect.get(JsonlPersistence, 'default');
  if (typeof legacy === 'function') {
    return legacy as Plugin.Constructor<JsonlPersistence.Config>;
  }
  if (typeof Reflect.get(JsonlPersistence, 'apply') === 'function') {
    return JsonlPersistence as unknown as Plugin.Object<JsonlPersistence.Config>;
  }
  throw new Error('DSH JSONL persistence does not expose a supported Cordis plugin');
}
export const JsonlSessionPersistence = jsonlPersistencePlugin();
export { default as SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
export * as ShellEnv from '@deepseek-ai/dsh-shell-env';
export * as ToolBash from '@deepseek-ai/dsh-tool-bash';

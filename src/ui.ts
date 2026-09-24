import type { Progress, RuntimeStatus } from './types.js';
import { CONNECTOR_NAME, RUNTIME_NAME } from './branding.js';
import { CONTEXT_OUTCOMES, type ContextDiagnosticsSnapshot, type ContextOutcome } from './context-diagnostics.js';
import { OPENCLAW_COMPATIBILITY_RANGE } from './compatibility.js';

export type BridgeUiState = {
  client: { state: string; failure?: string };
  runtime?: RuntimeStatus;
  lastProgress?: Progress;
  context?: ContextDiagnosticsSnapshot & { enabled: boolean };
};

/** User-facing status text for chat and CLI command surfaces. */
export function formatStatus(state: BridgeUiState): string {
  const runtime = state.runtime;
  const lines = [
    `${CONNECTOR_NAME}：${clientLabel(state.client.state)}`,
    `OpenClaw 兼容范围：${OPENCLAW_COMPATIBILITY_RANGE}`,
  ];
  if (state.client.failure) lines.push(`最近错误：${state.client.failure}`);
  if (runtime) {
    lines.push(`运行版本：${runtime.revision}`);
    lines.push(`任务：${runtime.active} 个执行中，${runtime.queued} 个排队`);
    lines.push(`能力：${runtime.capabilities.map(item => item.name).join('、') || '无'}`);
    if (runtime.cleanupErrors?.length) lines.push(`资源清理异常（建议重启扩展进程）：${runtime.cleanupErrors.join('；')}`);
    for (const component of runtime.components) {
      lines.push(`组件 ${component.id}@${component.version}：${componentLabel(component.state)}${component.reason ? `（${component.reason}）` : ''}`);
    }
  }
  if (state.lastProgress) lines.push(`最近进度：${progressLabel(state.lastProgress.state)} · ${state.lastProgress.message}`);
  if (state.context) lines.push(...contextStatus(state.context));
  lines.push('使用 /conest reload 可重新读取组件配置；执行中的任务继续使用原版本。');
  return lines.join('\n');
}

/** Authenticated user-facing Control UI page. */
export function renderStatusPage(state: BridgeUiState): string {
  const runtime = state.runtime;
  const componentRows = runtime?.components.map(component => `
    <tr><td>${escapeHtml(component.id)}</td><td>${escapeHtml(component.version)}</td><td>${escapeHtml(componentLabel(component.state))}</td><td>${escapeHtml(component.reason ?? '')}</td></tr>`).join('') ?? '';
  const capabilityRows = runtime?.capabilities.map(capability => `
    <tr><td><code>${escapeHtml(capability.name)}</code></td><td>${escapeHtml(capability.description)}</td><td>${escapeHtml(capability.permissions.join(', '))}</td></tr>`).join('') ?? '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${CONNECTOR_NAME}</title><style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#131b2e;--line:#2a3855;--text:#eef4ff;--muted:#9fb0ca;--good:#5ee6a8;--warn:#ffc857}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:28px}
h1{margin:0 0 6px}.sub{color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0}.card,.table{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}.card b{display:block;font-size:21px;margin-top:4px}.good{color:var(--good)}.warn{color:var(--warn)}
.table{margin-top:14px;overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px;border-top:1px solid var(--line)}th{color:var(--muted)}code{color:#9ee7ff}@media(max-width:760px){.metrics{grid-template-columns:1fr 1fr}main{padding:18px}}
</style></head><body><main><h1>${CONNECTOR_NAME} 运行状态</h1><div class="sub">OpenClaw ${OPENCLAW_COMPATIBILITY_RANGE} · ${RUNTIME_NAME} · optional Cordis/DSH adapter</div>
<section class="metrics"><div class="card">进程状态<b class="${state.client.state === 'ready' ? 'good' : 'warn'}">${escapeHtml(clientLabel(state.client.state))}</b></div>
<div class="card">运行版本<b>${escapeHtml(runtime?.revision ?? '—')}</b></div><div class="card">执行 / 排队<b>${runtime ? `${runtime.active} / ${runtime.queued}` : '—'}</b></div><div class="card">内存 RSS<b>${runtime ? formatBytes(runtime.memoryRssBytes) : '—'}</b></div></section>
${state.client.failure ? `<section class="card warn">最近错误：${escapeHtml(state.client.failure)}</section>` : ''}
${state.context ? `<section class="table" id="context-diagnostics"><h2>动态上下文</h2>${contextStatus(state.context).map(line => `<div>${escapeHtml(line)}</div>`).join('')}</section>` : ''}
<section class="table"><h2>组件</h2><table><thead><tr><th>组件</th><th>版本</th><th>状态</th><th>说明</th></tr></thead><tbody>${componentRows}</tbody></table></section>
<section class="table"><h2>可用能力</h2><table><thead><tr><th>能力</th><th>用途</th><th>权限</th></tr></thead><tbody>${capabilityRows}</tbody></table></section>
</main></body></html>`;
}

export function renderToolResult(capability: string, value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const result = value as Record<string, unknown>;
  if (capability === 'knowledge_search' && Array.isArray(result.matches)) {
    const matches = result.matches as Array<Record<string, unknown>>;
    const header = `找到 ${String(result.totalMatches ?? matches.length)} 条匹配，用时 ${String(result.durationMs ?? '?')} ms。`;
    const rows = matches.slice(0, 30).map(match => `${String(match.path)}:${String(match.lineNumber)}: ${String(match.line)}`);
    if (result.truncated) rows.push('结果已截断，请缩小检索范围。');
    return [header, ...rows].join('\n');
  }
  if (capability === 'knowledge_verify') {
    const sources = Array.isArray(result.sources) ? result.sources as Array<Record<string, unknown>> : [];
    const header = result.verified ? '引用验证通过：查询结果来源中包含原文。' : '引用验证未通过：未找到同时匹配查询和原文的来源。';
    return [header, ...sources.slice(0, 20).map(source => `${String(source.path)}:${String(source.lineNumber)}: ${String(source.line)}`)].join('\n');
  }
  return JSON.stringify(value, null, 2);
}

/** Public progress copy rendered by OpenClaw channel progress surfaces. */
export function renderProgress(progress: Progress): string {
  if (progress.state === 'queued') return `${CONNECTOR_NAME} 正在排队`;
  if (progress.state === 'cancelled') return `${CONNECTOR_NAME} 已取消`;
  if (progress.state === 'failed') return `${CONNECTOR_NAME} 执行失败`;
  if (progress.state === 'completed') return `${CONNECTOR_NAME} 已完成`;
  if (progress.message.includes('candidate')) return '正在查找候选来源';
  if (progress.message.includes('quoted')) return '正在核对引用原文';
  return '正在检索工作区';
}

function clientLabel(state: string): string {
  return ({ ready: '就绪', starting: '启动中', stopped: '已停止', failed: '故障' } as Record<string, string>)[state] ?? state;
}
function componentLabel(state: string): string {
  return ({ ready: '就绪', disabled: '已停用', blocked: '依赖受阻' } as Record<string, string>)[state] ?? state;
}
function progressLabel(state: string): string {
  return ({ queued: '排队', running: '执行中', completed: '完成', cancelled: '已取消', failed: '失败' } as Record<string, string>)[state] ?? state;
}
function formatBytes(value: number): string { return `${(value / 1024 / 1024).toFixed(1)} MiB`; }
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function contextStatus(context: ContextDiagnosticsSnapshot & { enabled: boolean }): string[] {
  const lines = [`动态上下文：${context.enabled ? '已启用' : '未启用'}；${context.active} 个构建中，${context.transports} 个传输未结束`,
    `上下文结果：${CONTEXT_OUTCOMES.map(outcome => `${contextLabel(outcome)} ${context.counts[outcome]}`).join(' · ')}`];
  if (context.last) lines.push(`最近上下文：${contextLabel(context.last.outcome)}，${context.last.durationMs} ms${context.last.code ? `（${context.last.code}）` : ''}`);
  lines.push('仅记录原因码、计数和耗时；不记录任务文本、来源内容或会话标识。');
  return lines;
}

function contextLabel(outcome: ContextOutcome): string {
  return { contributed: '已贡献', empty: '无匹配', denied: '权限不足', unavailable: '提供器不可用', stale: '版本已变更',
    timeout: '超时', cancelled: '已取消', invalid: '输出无效', busy: '并发已满', failed: '执行失败' }[outcome];
}

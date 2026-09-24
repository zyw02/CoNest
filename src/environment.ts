/** Minimal OS execution environment; provider credentials never enter component workers. */
export function executionEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TZ|TERM|COLORTERM|NO_COLOR|SystemRoot|WINDIR|PATHEXT|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA|DSH_NODE_PTY_SPAWN_HELPER)$/i;
  return Object.fromEntries(Object.entries(source).filter(([name, value]) => value !== undefined && allowed.test(name)));
}

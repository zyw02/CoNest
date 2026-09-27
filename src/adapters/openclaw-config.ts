import * as routing from 'openclaw/plugin-sdk/routing';
import * as snapshot from 'openclaw/plugin-sdk/runtime-config-snapshot';

// Namespace imports allow older hosts to load the plugin without linking exports
// introduced after July. Keep current host behavior whenever the API exists.

export const createRuntimeConfigReader: typeof snapshot.createRuntimeConfigReader = input => {
  if (typeof snapshot.createRuntimeConfigReader === 'function') return snapshot.createRuntimeConfigReader(input);
  return () => snapshot.selectApplicableRuntimeConfig({
    inputConfig: input,
    runtimeConfig: snapshot.getRuntimeConfigSnapshot(),
    runtimeSourceConfig: snapshot.getRuntimeConfigSourceSnapshot(),
  }) ?? input;
};

export const isIncognitoSessionKey: typeof routing.isIncognitoSessionKey = key => {
  if (typeof routing.isIncognitoSessionKey === 'function') return routing.isIncognitoSessionKey(key);
  return typeof key === 'string' && /^agent:[^:]+:(?:dashboard|subagent|internal-session-effects):incognito-[^:]+$/u.test(key.trim().toLowerCase());
};

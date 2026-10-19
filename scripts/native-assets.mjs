import assert from 'node:assert/strict';
import { supportedTargets } from '../src/platform-support.mjs';

export function nativePackageNames(target) {
  assert(supportedTargets.includes(target), `Unsupported target: ${target}`);
  return [
    `@img/sharp-${target}`,
    ...(target.startsWith('win32-') ? [] : [`@img/sharp-libvips-${target}`]),
    `@koromix/koffi-${target}`,
    `@vscode/ripgrep-${target}`,
    ...(target.startsWith('win32-') ? [] : [`@deepseek-ai/node-addon-system-${target}`]),
  ];
}

export function ptyFiles(target) {
  assert(supportedTargets.includes(target), `Unsupported target: ${target}`);
  if (target === 'linux-x64') return ['build/Release/pty.node'];
  return [`prebuilds/${target}/pty.node`, ...(target.startsWith('darwin-') ? [`prebuilds/${target}/spawn-helper`] : [])];
}

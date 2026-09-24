import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('lib/src', 'dist', { recursive: true });
await cp('openclaw.plugin.json', 'dist/openclaw.plugin.json');

await cp('src/mcp-memory-server.mjs', 'dist/mcp-memory-server.mjs');
await cp('src/studio/studio.html', 'dist/studio/studio.html');
await import('./build-studio.mjs');

await cp('scripts/demo-studio.mjs', 'dist/demo-studio.mjs');
await cp('scripts/demo-components.mjs', 'dist/demo-components.mjs');
await cp('scripts/live-deepseek.mjs', 'dist/live-deepseek.mjs');

await cp('src/platform-support.mjs', 'dist/platform-support.mjs');

await cp('scripts/probe-platform.mjs', 'dist/probe-platform.mjs');
await import('node:fs/promises').then(async fs => fs.writeFile('dist/probe-platform.mjs', (await fs.readFile('dist/probe-platform.mjs','utf8')).replace('../dist/studio/','./studio/')));

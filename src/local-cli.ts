#!/usr/bin/env node
import path from 'node:path';
import { askLocal, doctorLocal, readLocal, serveLocal, setupLocal, startLocal, statusLocal, stopLocal } from './local.js';
import { errorData } from './types.js';

try {
  const args = process.argv.slice(2);
  const command = args.shift();
  const options = new Map<string, string>();
  let probe = false;
  while (args.length) {
    const name = args.shift()!;
    if (name === '--probe' && !probe) { probe = true; continue; }
    if (!['--state', '--workspace', '--credentials', '--port', '--message', '--agent'].includes(name) || options.has(name)) throw new Error(`Unknown or repeated option: ${name}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    options.set(name, value);
  }
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write('Usage: conest-local setup --state NEW_DIR --workspace EXISTING_DIR --credentials PRIVATE_FILE [--port PORT]\n       conest-local doctor|start|serve|status|stop --state DIR [--probe]\n       conest-local ask --state DIR --message TEXT [--agent ID]\n');
  } else {
    const allowed = command === 'setup' ? ['--state', '--workspace', '--credentials', '--port'] :
      command === 'ask' ? ['--state', '--message', '--agent'] : ['--state'];
    if ((probe && command !== 'doctor') || [...options.keys()].some(name => !allowed.includes(name))) {
      throw new Error('An option is not valid for this local command; --probe is only available with doctor');
    }
    const directory = options.get('--state');
    if (!directory) throw new Error('Specify the dedicated local profile with --state DIR');
    let result: unknown;
    if (command === 'setup') {
      const workspace = options.get('--workspace');
      const credentials = options.get('--credentials');
      if (!workspace || !credentials) throw new Error('setup requires --workspace and --credentials');
      const profile = await setupLocal(path.resolve(directory), { workspace: path.resolve(workspace), credentials: path.resolve(credentials),
        ...(options.has('--port') ? { port: Number(options.get('--port')) } : {}) });
      result = { created: profile.directory, model: 'deepseek/deepseek-v4-flash', port: profile.settings.port, credentials: 'referenced, not copied' };
    } else {
      const profile = await readLocal(directory);
      if (command === 'doctor') result = await doctorLocal(profile, probe);
      else if (command === 'start') result = await startLocal(profile);
      else if (command === 'serve') await serveLocal(profile);
      else if (command === 'stop') result = await stopLocal(profile);
      else if (command === 'status') result = await statusLocal(profile);
      else if (command === 'ask') result = await askLocal(profile, options.get('--message') ?? '', options.get('--agent') ?? 'main');
      else throw new Error(`Unknown local command: ${command}`);
    }
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify(errorData(error))}\n`);
  process.exitCode = 1;
}

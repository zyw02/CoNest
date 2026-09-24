import path from 'node:path';
import { readConfig, resolveConfig } from './config.js';
import { serve } from './server.js';

const args = process.argv.slice(2);
if (args[0] !== 'serve') throw new Error('Usage: worker.js serve [--config FILE | --workspace DIRECTORY]');
const memoryIndex = args.indexOf('--memory-file');
const memoryFileOverride = memoryIndex >= 0 ? path.resolve(requiredValue(args, memoryIndex, '--memory-file')) : undefined;
const configIndex = args.indexOf('--config');
const workspaceIndex = args.indexOf('--workspace');
if (configIndex >= 0 && workspaceIndex >= 0) throw new Error('Use either --config or --workspace');
const configFile = configIndex >= 0 ? path.resolve(requiredValue(args, configIndex, '--config')) : undefined;
const workspaceRoot = workspaceIndex >= 0 ? requiredValue(args, workspaceIndex, '--workspace') : process.cwd();
const loadConfig = () => configFile
  ? readConfig(path.resolve(configFile), memoryFileOverride)
  : resolveConfig({ workspaceRoot: path.resolve(workspaceRoot) }, process.cwd(), memoryFileOverride);
const config = loadConfig();
process.chdir(config.workspaceRoot);
await serve({ config, configFile, loadConfig, memoryFileOverride });

function requiredValue(values: string[], index: number, option: string): string {
  const value = values[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

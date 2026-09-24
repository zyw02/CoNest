import { managedSearchTools } from './search-contract.js';
import { managedReadTools } from './read-contract.js';
import { managedMemoryTools } from './memory-contract.js';
export const managedDshTools = [...managedSearchTools, ...managedReadTools, ...managedMemoryTools] as const;
export const DIRECT_CAPABILITY_NAMES = ['knowledge_search', 'knowledge_verify', ...managedDshTools.map(tool => tool.openClawName)] as const;
export function isManagedDshTool(name: string): boolean { return managedDshTools.some(tool => tool.openClawName === name); }

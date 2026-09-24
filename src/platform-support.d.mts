export function assertRuntime(platform?: string, arch?: string, node?: string, glibc?: string): void;
export function protectDirectory(directory: string): Promise<void>;
export function assertPrivateFile(file: string): Promise<void>;
export function stopProcessTree(child: import('node:child_process').ChildProcess): Promise<void>;

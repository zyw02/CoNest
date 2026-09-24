import type { FsTarget, FsObservation } from './adapters/dsh-filesystem.js';

export const managedReadTools = [
  {
    "openClawName": "dsh_read",
    "dshName": "read",
    "description": "Read a UTF-8 text file and return line-numbered content.",
    "parameters": {
      "type": "object",
      "properties": {
        "file_path": {
          "type": "string",
          "description": "Path to read, resolved by the filesystem backend."
        },
        "offset": {
          "type": "number",
          "description": "1-based first line to return. Defaults to 1."
        },
        "limit": {
          "type": "number",
          "description": "Maximum number of lines to return. Defaults to 2000."
        }
      },
      "required": [
        "file_path"
      ]
    }
  }
] as const;

/** Trusted worker evidence, never accepted from model arguments. */
export type ReadObservation = { target: FsTarget; observation: FsObservation };
export type ManagedReadResult = {
  content: Array<{ type: 'text'; text: string }>; value?: unknown;
  isError: boolean; error?: { code: string; message: string };
  observation?: ReadObservation;
};

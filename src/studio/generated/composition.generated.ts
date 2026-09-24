// Snapshot of the fixed Gateway composition. Managed tools have separate contracts.
export const generatedComposition = {
  "tools": [
    {
      "openClawName": "dsh_write",
      "dshName": "write",
      "description": "Create or fully replace a UTF-8 text file.",
      "parameters": {
        "type": "object",
        "properties": {
          "file_path": {
            "type": "string",
            "description": "Path to write, resolved by the filesystem backend."
          },
          "content": {
            "type": "string",
            "description": "Full UTF-8 text content to write."
          },
          "sandbox_permissions": {
            "type": "string",
            "description": "The wider sandbox mode this file operation needs. Only valid as a one-shot retry of an operation the sandbox just denied; requires justification and user approval.",
            "enum": [
              "workspace-write",
              "danger-full-access"
            ]
          },
          "justification": {
            "type": "string",
            "description": "Required with sandbox_permissions: one sentence for the user explaining why this exact file operation needs the wider access."
          }
        },
        "required": [
          "file_path",
          "content"
        ]
      }
    },
    {
      "openClawName": "dsh_edit",
      "dshName": "edit",
      "description": "Edit an existing UTF-8 text file by replacing literal text.",
      "parameters": {
        "type": "object",
        "properties": {
          "file_path": {
            "type": "string",
            "description": "Path to edit, resolved by the filesystem backend."
          },
          "old_string": {
            "type": "string",
            "description": "Literal text to replace. Must match exactly."
          },
          "new_string": {
            "type": "string",
            "description": "Literal replacement text. Use an empty string to delete the match."
          },
          "replace_all": {
            "type": "boolean",
            "description": "Replace all matches. Defaults to false; when false, old_string must appear exactly once."
          },
          "sandbox_permissions": {
            "type": "string",
            "description": "The wider sandbox mode this file operation needs. Only valid as a one-shot retry of an operation the sandbox just denied; requires justification and user approval.",
            "enum": [
              "workspace-write",
              "danger-full-access"
            ]
          },
          "justification": {
            "type": "string",
            "description": "Required with sandbox_permissions: one sentence for the user explaining why this exact file operation needs the wider access."
          }
        },
        "required": [
          "file_path",
          "old_string",
          "new_string"
        ]
      }
    },
    {
      "openClawName": "dsh_read_image",
      "dshName": "read_image",
      "description": "Read a PNG/JPEG/WebP/GIF file and return the image itself. Requires the current model to accept image input.",
      "parameters": {
        "type": "object",
        "properties": {
          "file_path": {
            "type": "string",
            "description": "Path to the image file, resolved by the filesystem backend."
          }
        },
        "required": [
          "file_path"
        ]
      }
    },
    {
      "openClawName": "dsh_bash",
      "dshName": "bash",
      "description": "Execute a bash command (`bash -c`) and return its stdout/stderr. Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. Current harness environment facts are exposed through managed `$DSH_*` variables; inspect them when needed. Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. Background execution is not available; long-running commands must finish within the timeout. Attempting a command the sandbox may deny is safe and expected: run it and read the marker rather than assuming the denial. When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. Do not detour through chat to ask permission first — the approval prompt raised by that retry is how the user consents. If the session states approval prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. Never escalate speculatively: ground the request in a real denial — normally the one this command just hit; escalating up front is fine only when this session already denied the same access. A rejected escalation is final for that command — stop and explain, never work around it — but it does not forbid attempting or escalating other commands later.",
      "parameters": {
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "description": "The bash command to execute."
          },
          "description": {
            "type": "string",
            "description": "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: \"ls\" → \"List files in current directory\"; \"git status\" → \"Show working tree status\"; \"npm install\" → \"Install package dependencies\"."
          },
          "timeoutMs": {
            "type": "number",
            "description": "Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry."
          },
          "workdir": {
            "type": "string",
            "description": "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it."
          },
          "sandbox_permissions": {
            "type": "string",
            "description": "The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.",
            "enum": [
              "workspace-write",
              "danger-full-access"
            ]
          },
          "justification": {
            "type": "string",
            "description": "Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access."
          }
        },
        "required": [
          "command",
          "description"
        ]
      }
    }
  ]
} as const;

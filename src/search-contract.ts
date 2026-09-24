/** Stable DSH search surfaces, implemented by the managed dsh-search component. */
export const managedSearchTools = [
  {
    "openClawName": "dsh_glob",
    "dshName": "glob",
    "description": "Find files whose paths match a glob pattern. Returns matching file paths — never directories — including hidden and ignored files (VCS metadata directories are excluded). Up to 100 paths come back in modification-time order; a larger result returns the first 100 paths in modification-time order, says so, and reports where the complete sorted list was saved. This tool does not enumerate directory entries.",
    "parameters": {
      "type": "object",
      "properties": {
        "pattern": {
          "type": "string",
          "description": "Glob pattern to match file paths against (e.g. \"**/*.ts\", \"src/**/*.test.js\"). A pattern with no \"/\" matches the basename at any depth, so \"*\" and \"*.ts\" both search the whole tree; include a separator to anchor the depth."
        },
        "path": {
          "type": "string",
          "description": "Directory to search in. Defaults to the session workspace; a relative path resolves against it."
        }
      },
      "required": [
        "pattern"
      ]
    }
  },
  {
    "openClawName": "dsh_grep",
    "dshName": "grep",
    "description": "Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. Returns the first 250 matches inline; a capped result reports where the complete match list was saved. Use read on a matched file for surrounding context.",
    "parameters": {
      "type": "object",
      "properties": {
        "pattern": {
          "type": "string",
          "description": "Regular expression to search for (ripgrep syntax)."
        },
        "path": {
          "type": "string",
          "description": "File or directory to search. Defaults to the session workspace; a relative path resolves against it."
        },
        "include": {
          "type": "string",
          "description": "One glob filter for which files to search (e.g. \"*.ts\", \"*.{js,jsx}\"). Not a list; negation is not supported."
        }
      },
      "required": [
        "pattern"
      ]
    }
  }
] as const;

import type { CapabilityDescriptor, Permission } from "./types.js";
export const managedMemoryTools = [
  {
    "openClawName": "dsh_mcp__reference_memory__create_entities",
    "dshName": "mcp__reference_memory__create_entities",
    "description": "Create multiple new entities in the knowledge graph",
    "parameters": {
      "type": "object",
      "properties": {
        "entities": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "The name of the entity"
              },
              "entityType": {
                "type": "string",
                "description": "The type of the entity"
              },
              "observations": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "An array of observation contents associated with the entity"
              }
            },
            "required": [
              "name",
              "entityType",
              "observations"
            ]
          }
        }
      },
      "required": [
        "entities"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "openClawName": "dsh_mcp__reference_memory__create_relations",
    "dshName": "mcp__reference_memory__create_relations",
    "description": "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
    "parameters": {
      "type": "object",
      "properties": {
        "relations": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string",
                "description": "The name of the entity where the relation starts"
              },
              "to": {
                "type": "string",
                "description": "The name of the entity where the relation ends"
              },
              "relationType": {
                "type": "string",
                "description": "The type of the relation"
              }
            },
            "required": [
              "from",
              "to",
              "relationType"
            ]
          }
        }
      },
      "required": [
        "relations"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "openClawName": "dsh_mcp__reference_memory__add_observations",
    "dshName": "mcp__reference_memory__add_observations",
    "description": "Add new observations to existing entities in the knowledge graph",
    "parameters": {
      "type": "object",
      "properties": {
        "observations": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "entityName": {
                "type": "string",
                "description": "The name of the entity to add the observations to"
              },
              "contents": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "An array of observation contents to add"
              }
            },
            "required": [
              "entityName",
              "contents"
            ]
          }
        }
      },
      "required": [
        "observations"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "openClawName": "dsh_mcp__reference_memory__delete_entities",
    "dshName": "mcp__reference_memory__delete_entities",
    "description": "Delete multiple entities and their associated relations from the knowledge graph",
    "parameters": {
      "type": "object",
      "properties": {
        "entityNames": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "An array of entity names to delete"
        }
      },
      "required": [
        "entityNames"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "openClawName": "dsh_mcp__reference_memory__delete_observations",
    "dshName": "mcp__reference_memory__delete_observations",
    "description": "Delete specific observations from entities in the knowledge graph",
    "parameters": {
      "type": "object",
      "properties": {
        "deletions": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "entityName": {
                "type": "string",
                "description": "The name of the entity containing the observations"
              },
              "observations": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "An array of observations to delete"
              }
            },
            "required": [
              "entityName",
              "observations"
            ]
          }
        }
      },
      "required": [
        "deletions"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "openClawName": "dsh_mcp__reference_memory__delete_relations",
    "dshName": "mcp__reference_memory__delete_relations",
    "description": "Delete multiple relations from the knowledge graph",
    "parameters": {
      "type": "object",
      "properties": {
        "relations": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string",
                "description": "The name of the entity where the relation starts"
              },
              "to": {
                "type": "string",
                "description": "The name of the entity where the relation ends"
              },
              "relationType": {
                "type": "string",
                "description": "The type of the relation"
              }
            },
            "required": [
              "from",
              "to",
              "relationType"
            ]
          },
          "description": "An array of relations to delete"
        }
      },
      "required": [
        "relations"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "openClawName": "dsh_mcp__reference_memory__read_graph",
    "dshName": "mcp__reference_memory__read_graph",
    "description": "Read the entire knowledge graph",
    "parameters": {
      "type": "object",
      "properties": {},
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "openClawName": "dsh_mcp__reference_memory__search_nodes",
    "dshName": "mcp__reference_memory__search_nodes",
    "description": "Search for nodes in the knowledge graph based on a query",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "The search query to match against entity names, types, and observation content"
        }
      },
      "required": [
        "query"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "openClawName": "dsh_mcp__reference_memory__open_nodes",
    "dshName": "mcp__reference_memory__open_nodes",
    "description": "Open specific nodes in the knowledge graph by their names",
    "parameters": {
      "type": "object",
      "properties": {
        "names": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "An array of entity names to retrieve"
        }
      },
      "required": [
        "names"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  }
] as const;
export function memoryPermission(name: string): Permission {
  return /__(read_graph|search_nodes|open_nodes)$/.test(name) || name === 'memory_recall' ? 'memory:read' : 'memory:write';
}
export const MEMORY_CAPABILITIES = [...managedMemoryTools.map(tool => tool.openClawName), 'memory_recall', 'memory_remember'];
export const memoryCapabilities: CapabilityDescriptor[] = [
  ...managedMemoryTools.map(tool => ({ name: tool.openClawName, description: tool.description,
    inputSchema: tool.parameters, permissions: [memoryPermission(tool.openClawName)] })),
  { name: 'memory_recall', description: 'Recall automatic memory belonging to the authenticated principal.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }, permissions: ['memory:read'] },
  { name: 'memory_remember', description: 'Store one bounded automatic memory for the authenticated principal.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { observation: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['observation'] }, permissions: ['memory:write'] },
];

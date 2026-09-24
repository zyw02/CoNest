/** Product names are distinct from stable protocol, configuration, and storage identifiers. */
export const PRODUCT_NAME = 'CoNest';
export const CONNECTOR_NAME = 'CoNest Connector';
export const CONNECTOR_FULL_NAME = 'CoNest Connector for OpenClaw';
export const RUNTIME_NAME = 'CoNest Runtime';

// Preserve the installed plugin identity so existing allowlists and configuration still work.
export const PLUGIN_ID = 'dsh-bridge';
export const COMMAND_NAMES = ['conest', 'bridge'] as const;
export const STATUS_PATHS = ['/plugins/conest-connector', '/plugins/dsh-bridge'] as const;

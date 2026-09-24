# CoNest for DSH Web

Adds **CoNest 统一生态** to Settings → Plugins. The OpenClaw and DSH entries load the same live Studio view and authenticated API, so the catalog, market digest, shared memory and execution history are identical.

Install this directory as a DSH plugin using the host's local plugin installation command. The tested source target is DSH 0.1.0-rc.5. Open the tab and enter the CoNest Studio address (default `http://127.0.0.1:18791/plugins/conest-studio`), then authenticate with the OpenClaw Gateway token. On a remote browser, use the reachable forwarded address instead of the server's loopback address.

This companion supplies the DSH UI entry; install the CoNest Connector in OpenClaw for execution. Market discovery uses the same upstream catalog as DSH Market. Displaying a market package does not claim that its runtime dependencies are installed or compatible.

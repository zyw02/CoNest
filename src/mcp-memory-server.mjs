process.stdin.once('end', () => process.exit(0));
// Node 24 can let the official server entry exit during its un-awaited async
// bootstrap when stdin is a pipe. Keep the process referenced until its MCP
// transport owns stdin; terminate normally when the parent closes the pipe.
const bootstrapGuard = setInterval(() => {}, 60_000)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    clearInterval(bootstrapGuard)
    process.exit(0)
  })
}

await import('@modelcontextprotocol/server-memory/dist/index.js')

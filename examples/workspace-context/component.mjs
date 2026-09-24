export default {
  name: 'workspace-context',
  inject: ['bridgeCapabilities'],
  apply(ctx) {
    ctx.bridgeCapabilities.register(ctx, 'workspace_context', async (args, invocation) => {
      // Deliberately simple literal retrieval, not a semantic ranker or a second agent.
      const terms = [...new Set(args.task.match(/[\p{L}\p{N}_-]{3,100}/gu) ?? [])]
        .sort((a, b) => b.length - a.length).slice(0, 3);
      const seen = new Set();
      let text = '';
      for (const query of terms) {
        invocation.signal.throwIfAborted();
        const result = await ctx.bridgeCapabilities.invoke('knowledge_search', { query }, invocation);
        for (const match of result.matches) {
          const key = `${match.path}:${match.lineNumber}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const line = `${key}: ${match.line}\n`;
          if (text.length + line.length > args.maxChars) continue;
          text += line;
          if (seen.size >= 8) return { text };
        }
      }
      return { text };
    });
  },
};

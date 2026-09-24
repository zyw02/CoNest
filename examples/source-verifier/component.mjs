export default {
  name: 'source-verifier',
  inject: ['bridgeCapabilities'],
  apply(ctx, config) {
    ctx.bridgeCapabilities.register(ctx, 'source_verify', async (args, invocation) => {
      invocation.progress('Selecting candidate sources through the DSH dependency');
      const candidates = await ctx.bridgeCapabilities.invoke('knowledge_search', { query: args.query }, invocation);
      invocation.progress('Checking the exact quoted text through the DSH dependency');
      const quoted = await ctx.bridgeCapabilities.invoke('knowledge_search', { query: args.quote }, invocation);
      const paths = new Set(candidates.matches.map(match => match.path));
      const sources = quoted.matches.filter(match => paths.has(match.path));
      return { verified: sources.length > 0, label: config.label ?? 'source-verifier', sources };
    });
  },
};

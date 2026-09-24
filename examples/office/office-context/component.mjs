export default {
  inject: ['bridgeCapabilities', 'officeKnowledge'],
  apply(ctx) {
    ctx.bridgeCapabilities.register(ctx, 'office_context', async args => ({
      text: JSON.stringify(ctx.officeKnowledge.policy()).slice(0, args.maxChars),
    }));
  },
};

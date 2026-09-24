export default {
  inject: ['bridgeCapabilities'],
  apply(ctx, config) {
    if (config.invalid) throw new Error('Rejected office policy candidate');
    const policy = Object.freeze({ source: config.source ?? 'Customer A', revision: config.revision ?? 'A-1', requiredAttachment: config.requiredAttachment ?? true });
    ctx.provide('officeKnowledge', { policy: () => policy });
    ctx.bridgeCapabilities.register(ctx, 'office_policy', async () => policy);
  },
};

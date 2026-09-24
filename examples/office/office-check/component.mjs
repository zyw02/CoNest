import { setTimeout } from 'node:timers/promises';
export default {
  inject: ['bridgeCapabilities', 'officeKnowledge'],
  apply(ctx) {
    ctx.bridgeCapabilities.register(ctx, 'office_check', async (args, invocation) => {
      const before = ctx.officeKnowledge.policy();
      if (args.delayMs) {
        invocation.progress('Office check admitted; retaining its policy generation');
        await setTimeout(args.delayMs, undefined, { signal: invocation.signal });
      }
      const after = ctx.officeKnowledge.policy();
      return { passed: !before.requiredAttachment || args.attachment, policy: before, consistent: before === after,
        finding: before.requiredAttachment && !args.attachment ? 'Required attachment is missing' : 'Attachment rule passed' };
    });
  },
};

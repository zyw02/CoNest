import type { Fiber } from '@deepseek-ai/cordis';

/** Cordis implementation boundary for CoNest's optional DSH support pack. */
export { Context } from '@deepseek-ai/cordis';
export type { Context as CordisContext, Fiber, FiberState } from '@deepseek-ai/cordis';

/** Cordis replaced thenable fibers with an explicit lifecycle await method. */
export async function settleFiber(fiber: Fiber): Promise<Fiber> {
  const settle: unknown = Reflect.get(fiber, 'await');
  if (typeof settle === 'function') await Reflect.apply(settle, fiber, []);
  else await fiber;
  return fiber;
}

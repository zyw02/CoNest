import type { Readable } from 'node:stream';
import { BridgeError } from './types.js';

/** Enforce the frame limit before readline-style buffering can grow unbounded. */
export function readFrames(
  stream: Readable,
  limit: () => number,
  onLine: (line: string) => void,
  onError: (error: Error) => void,
): void {
  let buffered = Buffer.alloc(0);
  let failed = false;
  stream.on('data', (data: Buffer | string) => {
    if (failed) return;
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const slice = chunk.subarray(offset, end < 0 ? chunk.length : end);
      if (buffered.length + slice.length > limit()) {
        failed = true;
        onError(new BridgeError('PAYLOAD_TOO_LARGE', 'The protocol frame exceeded its configured byte limit'));
        return;
      }
      buffered = Buffer.concat([buffered, slice]);
      if (end < 0) return;
      const line = buffered.toString('utf8');
      buffered = Buffer.alloc(0);
      onLine(line);
      offset = end + 1;
    }
  });
  stream.on('error', onError);
}

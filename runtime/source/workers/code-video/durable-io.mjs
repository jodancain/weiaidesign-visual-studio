import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const SHARING_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS = [10, 20, 40, 80, 160, 320, 640];

// Windows readers/security scanners may temporarily deny replacement. Never
// unlink the destination or fall back to a non-atomic copy. Other errors fail
// immediately; even a permanent sharing/permission error exhausts in 1.27 s.
export async function retrySharing(operation, { delays = RETRY_DELAYS, sleep = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!SHARING_ERRORS.has(error.code) || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}
export function durableRename(source, destination, { renameFile = rename, ...retry } = {}) {
  return retrySharing(() => renameFile(source, destination), retry);
}
export function durableReadFile(file, options, { read = readFile, ...retry } = {}) {
  return retrySharing(() => read(file, options), retry);
}
export async function atomicWrite(file, value) {
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await retrySharing(() => writeFile(temp, value));
  await durableRename(temp, file);
}
export function atomicJSON(file, value) { return atomicWrite(file, JSON.stringify(value, null, 2)); }

// Remotion does not await onFrameUpdate/onBrowserLog. Observe every Promise at
// creation, cancel rendering on first error, and propagate that original error
// from drain() after all started I/O has settled (rather than process crash).
export function callbackQueue(onError = () => {}) {
  let pending = Promise.resolve(), failure;
  return {
    push(operation) {
      pending = pending.then(async () => { if (!failure) await operation(); }).catch(error => {
        if (!failure) { failure = error; try { onError(error); } catch {} }
      });
    },
    async drain() { await pending; if (failure) throw failure; },
  };
}

// Checkpoint every PNG, but persist non-terminal progress at most once/250 ms.
// Final frame and stage transitions are always written; terminal job writes
// bypass this helper entirely.
export function throttledProgress(update, { interval = 250, now = () => performance.now() } = {}) {
  let last = -Infinity, stage;
  return async value => {
    const time = now();
    if (value.stage === stage && value.completedFrames < value.totalFrames && time - last < interval) return;
    await update(value); last = time; stage = value.stage;
  };
}

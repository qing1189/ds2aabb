import { acquireToken } from './auth.js';

const MAX_QUEUE_SIZE = 100;
const queue = [];

export function enqueueRequest(preferVision, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = queue.findIndex(e => e.resolve === resolve);
      if (idx !== -1) queue.splice(idx, 1);
      reject(new Error('Request timed out waiting for available token'));
    }, timeoutMs);

    // Try immediate acquire first
    const slot = acquireToken(preferVision);
    if (slot) {
      clearTimeout(timer);
      resolve(slot);
      return;
    }

    if (queue.length >= MAX_QUEUE_SIZE) {
      clearTimeout(timer);
      reject(new Error('Too many queued requests, try again later'));
      return;
    }

    queue.push({ preferVision, resolve: (slot) => { clearTimeout(timer); resolve(slot); }, reject: (err) => { clearTimeout(timer); reject(err); } });
  });
}

// Call when a token is released — try to dispatch queued request
export function dispatchQueued() {
  while (queue.length > 0) {
    const next = queue[0];
    const slot = acquireToken(next.preferVision);
    if (!slot) break; // No token available yet
    queue.shift();
    next.resolve(slot);
  }
}

export function getQueueInfo() {
  return { queued: queue.length, maxQueueSize: MAX_QUEUE_SIZE };
}

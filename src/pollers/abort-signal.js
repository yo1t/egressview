'use strict';

function abortError(signal, message = 'Operation aborted') {
  return signal?.reason instanceof Error ? signal.reason : new Error(message);
}

function attachAbortHandler(signal, onAbort, message) {
  if (!signal) return () => {};
  const handler = () => onAbort(abortError(signal, message));
  if (signal.aborted) {
    handler();
    return () => {};
  }
  signal.addEventListener('abort', handler, { once: true });
  return () => signal.removeEventListener('abort', handler);
}

module.exports = { abortError, attachAbortHandler };

// The controller runs in both Node and browsers.
export function delay(ms, value, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(value); }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

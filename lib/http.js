// Minimal fetch wrapper with timeout and readable errors.

export class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function fetchJson(url, { timeoutMs = 10000, ...init } = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.slice(0, 300).replace(/\s+/g, ' ');
    throw new HttpError(`${res.status} ${res.statusText}: ${snippet}`, res.status, text);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`Invalid JSON from ${new URL(url).host}`, res.status, text);
  }
}

// Run async fn over items with bounded concurrency; failures resolve to null.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

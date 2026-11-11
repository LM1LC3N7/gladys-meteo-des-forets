// -----------------------------------------------------------------------------
// The only network access: GET with a timeout covering the body too, the
// honest User-Agent, an explicit Accept, the ETag of the last answer (a 304
// costs no download), and a body read in chunks and cut past its byte budget
// (never read whole first). The tests pass their own `fetchImpl`. (From
// gladys-feux-canada.)
// -----------------------------------------------------------------------------

import { HTTP_TIMEOUT, USER_AGENT } from './constants.js';

/** A failure, with a code the app decides on. */
export class SourceError extends Error {
  /**
   * code: 'http' (status), 'not_found' (404), 'rate_limited' (429), 'server'
   * (5xx), 'timeout', 'network', 'too_large', 'bad_answer' (not the file
   * expected).
   */
  constructor(code, message, { status, retryAfter } = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Retry-After in ms (seconds or an HTTP date against `Date` of the answer), undefined otherwise. */
export function retryAfterMs(value, dateHeader) {
  const text = String(value ?? '').trim();
  // Any number of seconds: the app caps the pause (6 h).
  if (/^\d{1,12}$/.test(text)) {
    return Number(text) * 1000;
  }
  const at = Date.parse(text);
  const now = Date.parse(String(dateHeader ?? ''));
  return Number.isFinite(at) && Number.isFinite(now) ? Math.max(0, at - now) : undefined;
}

/**
 * GET `url`: `{ notModified: true }` on a 304 (the `etag` sent matched), else
 * `{ body: Buffer, etag }`, the body `maxBytes` at most. Throws a SourceError
 * ('not_found' on a 404: the file of the year does not exist yet).
 */
export async function getFile(
  url,
  {
    maxBytes,
    etag,
    accept = 'application/gzip, application/octet-stream;q=0.9, */*;q=0.1',
    timeout = HTTP_TIMEOUT,
    fetchImpl = globalThis.fetch,
    timers = globalThis,
  },
) {
  const controller = new AbortController();
  const timer = timers.setTimeout(() => controller.abort(), Math.max(1, timeout));
  const what = new URL(url).pathname.split('/').pop();
  const headers = { 'User-Agent': USER_AGENT, Accept: accept };
  // Only a strong or weak validator as S3 writes it: never a header split.
  if (typeof etag === 'string' && /^(W\/)?"[\x21\x23-\x7e]{1,200}"$/.test(etag)) {
    headers['If-None-Match'] = etag;
  }
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        headers,
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (err) {
      throw controller.signal.aborted
        ? new SourceError('timeout', `${what}: timeout`)
        : new SourceError('network', `${what}: ${err?.cause?.code ?? err?.name ?? 'network'}`);
    }
    if (response.status === 304) {
      await response.body?.cancel().catch(() => {});
      return { notModified: true };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      const retryAfter = retryAfterMs(
        response.headers.get('retry-after'),
        response.headers.get('date'),
      );
      const code =
        status === 404
          ? 'not_found'
          : status === 429
            ? 'rate_limited'
            : status >= 500
              ? 'server'
              : 'http';
      throw new SourceError(code, `${what}: HTTP ${status}`, { status, retryAfter });
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new SourceError('too_large', `${what}: answer over ${maxBytes} bytes`);
    }
    const chunks = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new SourceError('too_large', `${what}: answer over ${maxBytes} bytes`);
          }
          chunks.push(value);
        }
      } catch (err) {
        if (err instanceof SourceError) throw err;
        throw controller.signal.aborted
          ? new SourceError('timeout', `${what}: timeout`)
          : new SourceError('network', `${what}: ${err?.name ?? 'read failed'}`);
      }
    }
    const tag = response.headers.get('etag');
    return {
      body: Buffer.concat(chunks.map((c) => Buffer.from(c))),
      etag: tag && tag.length <= 210 ? tag : undefined,
    };
  } finally {
    timers.clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// The yearly file of the Météo des forêts: one GET (conditional on the ETag
// of the last answer), the gzip opened with a bound on its decompressed size
// (never a zip bomb), the CSV handed back as text.
// -----------------------------------------------------------------------------

import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { MAX_CSV_BYTES, MAX_GZIP_BYTES } from './constants.js';
import { SourceError, getFile } from './http.js';

const gunzipAsync = promisify(gunzip);

export class ForestSource {
  constructor({ fetchImpl = globalThis.fetch, timers = globalThis } = {}) {
    this.fetchImpl = fetchImpl;
    this.timers = timers;
  }

  /** `{ notModified: true }` or `{ csv, etag }`. Throws a SourceError. */
  async read(url, { etag } = {}) {
    const answer = await getFile(url, {
      maxBytes: MAX_GZIP_BYTES,
      etag,
      fetchImpl: this.fetchImpl,
      timers: this.timers,
    });
    if (answer.notModified) return answer;
    const csv = await decompress(answer.body);
    return { csv, etag: answer.etag };
  }
}

/** gzip -> UTF-8 text, MAX_CSV_BYTES at most; a plain CSV is taken as is. */
export async function decompress(body, maxBytes = MAX_CSV_BYTES) {
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      const out = await gunzipAsync(body, { maxOutputLength: maxBytes });
      return out.toString('utf8');
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
        throw new SourceError('too_large', `file over ${maxBytes} bytes once opened`);
      }
      throw new SourceError('bad_answer', 'damaged gzip file');
    }
  }
  if (body.length > maxBytes) throw new SourceError('too_large', `file over ${maxBytes} bytes`);
  return body.toString('utf8');
}

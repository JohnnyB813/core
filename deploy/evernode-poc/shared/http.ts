export const ALLOWED_READ = /^\/chain\/(?:head|block\/[1-9][0-9]{0,9}\/(?:hash|header))$/;
export function allowedReadPath(path: string): boolean {
  if (!ALLOWED_READ.test(path)) return false;
  const height = /^\/chain\/block\/(\d+)\//.exec(path);
  return !height || Number(height[1]) <= 0xffffffff;
}
export function endpoint(value: string): URL {
  if (typeof value !== 'string' || /\s/.test(value)) throw new Error('Invalid endpoint');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Expected an HTTP origin without credentials');
  if (!/^[a-z0-9.-]+$/i.test(url.hostname)) throw new Error('Unsupported endpoint host');
  return url;
}
export async function boundedJson(url: URL | string, timeoutMs = 3000, maxBytes = 65536): Promise<unknown> {
  const response = await fetch(url, {signal:AbortSignal.timeout(timeoutMs), redirect:'error', headers:{accept:'application/json'}});
  if (!response.ok || !response.body) {await response.body?.cancel(); throw new Error('Upstream HTTP ' + response.status);}
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {await reader.cancel(); throw new Error('Response exceeds byte limit');}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

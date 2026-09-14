import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Cannot hash undefined');
  return encoded;
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}
/** Hash raw bytes, distinct from the canonical-JSON identity helper. */
export function sha256(value:string|Uint8Array):string { return createHash('sha256').update(value).digest('hex'); }

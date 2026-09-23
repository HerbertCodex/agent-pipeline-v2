import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { s, type Infer } from '../domain/schema.js';

export const PREVIEW_STATE = '.apv/state/preview.json';
export const PREVIEW_LOG = '.apv/state/preview.log';
export const PREVIEW_PREVIOUS_LOG = '.apv/state/preview.prev.log';
export const PREVIEW_UPDATE_LOG = '.apv/state/preview-update.log';

/**
 * Record of the preview, kept after a stop or a failed update: `pid` null means no server of ours runs,
 * `branch` and `commit` stay those of the last preview that started (the base of « what changed »).
 */
export const previewStateSchema = s.object({
  version: s.literal(1),
  pid: s.nullable(s.number(2, 2 ** 31)),
  /** Start time of the leader in /proc (Linux), to tell our server from a reused pid. */
  procStart: s.nullable(s.string(0, 64)),
  port: s.number(1, 65535),
  host: s.nullable(s.string(1, 255)),
  branch: s.string(1, 250),
  commit: s.string(40, 64, /^[0-9a-f]+$/),
  startedAt: s.string(1, 64),
  stoppedAt: s.nullable(s.string(1, 64)),
  url: s.string(1, 2000),
  healthUrl: s.string(1, 2000),
  dir: s.string(1, 4096),
  lastFailure: s.nullable(s.object({ step: s.string(1, 64), at: s.string(1, 64), branch: s.string(1, 250), commit: s.string(0, 64), message: s.string(0, 2000) })),
});
export type PreviewState = Infer<typeof previewStateSchema>;

export function readPreviewState(repo: string): PreviewState | null {
  const file = join(repo, PREVIEW_STATE);
  if (!existsSync(file)) return null;
  try { return previewStateSchema.parse(JSON.parse(readFileSync(file, 'utf8')) as unknown); }
  catch { return null; }
}

export function writePreviewState(repo: string, state: PreviewState): void {
  const file = join(repo, PREVIEW_STATE);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(previewStateSchema.parse(state), null, 2)}\n`);
  renameSync(tmp, file);
}

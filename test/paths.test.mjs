import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalPath } from '../dist/domain/paths.js';
import { resolvePreviewDir } from '../dist/preview/config.js';

// macOS: /var is a symlink to /private/var and Git reports resolved roots. Reproduced here with a symlinked folder.
function linked(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apv-paths-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'real', 'repo'), { recursive: true });
  symlinkSync(join(root, 'real'), join(root, 'link'));
  return root;
}

test('canonicalPath resolves the existing ancestors and keeps the missing tail', t => {
  const root = linked(t);
  assert.equal(canonicalPath(join(root, 'link', 'repo')), join(root, 'real', 'repo'));
  assert.equal(canonicalPath(join(root, 'link', 'repo', 'not', 'yet')), join(root, 'real', 'repo', 'not', 'yet'));
  assert.equal(canonicalPath(join(root, 'link', 'repo', '..', 'repo')), join(root, 'real', 'repo'));
  assert.equal(canonicalPath('/'), '/');
});

test('a preview folder that does not exist yet, inside a repository reached through a symlink, is refused', t => {
  const root = linked(t);
  const env = { HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'xdg') };
  const config = { serve: { command: 'x', port: 1, env: {} }, steps: {}, health: { path: '/', timeoutSec: 60 } };
  // Before the fix, the missing folder stayed unresolved and escaped the check: the preview would have been
  // installed, and wiped at each update, inside the working tree.
  assert.throws(() => resolvePreviewDir(join(root, 'real', 'repo'), { ...config, dir: join(root, 'link', 'repo', 'apercu') }, env), /dans le dépôt/);
  assert.throws(() => resolvePreviewDir(join(root, 'link', 'repo'), { ...config, dir: join(root, 'real', 'repo', 'apercu') }, env), /dans le dépôt/);
});

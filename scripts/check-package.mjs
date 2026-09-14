// Validate the actual npm artifact, including non-code role/skill assets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const tarball = resolve(process.argv[2] ?? `${pkg.name}-${pkg.version}.tgz`);
const root = mkdtempSync(join(tmpdir(), "apv2-package-"));
const call = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw new Error(`${cmd} failed: ${r.stderr}\n${r.stdout}`);
  return r.stdout;
};
try {
  call("npm", [
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    root,
    tarball,
  ]);
  const installed = join(root, "node_modules", pkg.name);
  const cli = join(installed, "dist/cli.js");
  assert.equal(call(process.execPath, [cli, "--version"]).trim(), pkg.version);
  assert.equal(
    JSON.parse(call(process.execPath, [cli, "roles"])).roles.length,
    4,
  );
  assert.equal(
    JSON.parse(call(process.execPath, [cli, "skills", "list"])).length,
    6,
  );
  const checks = call(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-concurrency=2",
      "test/knowledge.test.mjs",
      "test/claude.test.mjs",
      "test/bootstrap.test.mjs",
    ],
    installed,
  );
  assert.match(checks, /# fail 0/);
  const demo = JSON.parse(
    call(process.execPath, [join(installed, "scripts/demo-lifecycle.mjs")]),
  );
  assert.equal(demo.status, "closed");
  console.log(
    JSON.stringify(
      {
        version: pkg.version,
        offlineInstall: true,
        roles: 4,
        skills: 6,
        providerKnowledgeAndBootstrapTestsPassed: true,
        lifecycleClosed: true,
        realProviderCalls: false,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

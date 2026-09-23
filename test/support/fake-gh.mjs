#!/usr/bin/env node
// Fake `gh` for the `apv stack` tests (APV_GH). State in the JSON file named by FAKE_GH_STATE:
// { prs: { "<n>": { ...gh pr view fields } }, behavior: { editIgnored: [n], editFail: [n], mergeFail: [n],
//   headMovesAtMerge: [n], unknownViews: { "<n>": count }, afterMerge: { "<n>": { "<m>": { ...fields } } } }, calls: [[...args]] }.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
state.calls ??= [];
state.behavior ??= {};
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
const option = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const [group, action, number] = args;
const pr = state.prs[number];
let code = 0;
if (group !== 'pr' || !pr) {
  process.stderr.write(`no pull requests found for ${number}\n`);
  code = 1;
} else if (action === 'view') {
  const left = state.behavior.unknownViews?.[number] ?? 0;
  if (left > 0) state.behavior.unknownViews[number] = left - 1;
  const fields = option('--json').split(',');
  const view = Object.fromEntries(fields.filter(f => f in pr).map(f => [f, pr[f]]));
  if (left > 0) Object.assign(view, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  process.stdout.write(`${JSON.stringify(view)}\n`);
} else if (action === 'edit') {
  if (state.behavior.editFail?.includes(Number(number))) { process.stderr.write('GraphQL: Base branch was modified (updatePullRequest)\n'); code = 1; }
  else if (!state.behavior.editIgnored?.includes(Number(number))) pr.baseRefName = option('--base');
  if (code === 0) process.stdout.write(`https://github.com/o/r/pull/${number}\n`);
} else if (action === 'ready') {
  pr.isDraft = false;
  if (pr.mergeStateStatus === 'DRAFT') pr.mergeStateStatus = 'CLEAN';
  process.stdout.write(`✓ Pull request o/r#${number} is marked as "ready for review"\n`);
} else if (action === 'merge') {
  if (state.behavior.headMovesAtMerge?.includes(Number(number))) pr.headRefOid = 'e'.repeat(40);
  const head = option('--match-head-commit');
  if (head && head !== pr.headRefOid) { process.stderr.write(`GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)\n`); code = 1; }
  else if (state.behavior.mergeFail?.includes(Number(number))) { process.stderr.write('X Pull request o/r#' + number + ' is not mergeable: the base branch policy prohibits the merge.\n'); code = 1; }
  else {
    pr.state = 'MERGED';
    for (const [other, fields] of Object.entries(state.behavior.afterMerge?.[number] ?? {})) Object.assign(state.prs[other], fields);
    process.stdout.write(`✓ Merged pull request o/r#${number} (${pr.headRefName})\n`);
  }
} else { process.stderr.write(`unknown command ${action}\n`); code = 1; }
save();
process.exitCode = code;

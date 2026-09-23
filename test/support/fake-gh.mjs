#!/usr/bin/env node
// Fake `gh` for the `apv stack` tests (APV_GH). State in the JSON file named by FAKE_GH_STATE:
// { prs: { "<n>": { ...gh pr view fields } }, behavior: { retargetIgnored: [n], retargetFail: [n], mergeFail: [n],
//   headMovesAtMerge: [n], unknownViews: { "<n>": count }, afterMerge: { "<n>": { "<m>": { ...fields } } } }, calls: [[...args]] }.
// The repository is o/r on github.com. The retarget goes through `gh api -X PATCH repos/o/r/pulls/<n> -f base=<b>`;
// `gh pr edit` fails as it did on the real merge of PR #70 and #71 (deprecated classic projects).
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
if (group === 'api') {
  const path = args.find(a => a.startsWith('repos/'));
  const m = /^repos\/o\/r\/pulls\/(\d+)$/.exec(path ?? '');
  const target = state.prs[m?.[1]];
  const base = args.find((a, k) => args[k - 1] === '-f' && a.startsWith('base='))?.slice(5);
  if (option('-X') !== 'PATCH' || !target || !base) { process.stderr.write(`gh: Not Found (HTTP 404)\n`); code = 1; }
  else if (state.behavior.retargetFail?.includes(target.number)) {
    process.stdout.write('{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"invalid","field":"base"}],"status":"422"}');
    process.stderr.write('gh: Validation Failed (HTTP 422)\n'); code = 1;
  } else {
    if (!state.behavior.retargetIgnored?.includes(target.number)) target.baseRefName = base;
    process.stdout.write(`${JSON.stringify({ number: target.number, state: 'open', base: { ref: target.baseRefName }, head: { ref: target.headRefName } })}\n`);
  }
} else if (group !== 'pr' || !pr) {
  process.stderr.write(`no pull requests found for ${number}\n`);
  code = 1;
} else if (action === 'view') {
  const left = state.behavior.unknownViews?.[number] ?? 0;
  if (left > 0) state.behavior.unknownViews[number] = left - 1;
  const fields = option('--json').split(',');
  const view = Object.fromEntries(fields.filter(f => f in pr).map(f => [f, pr[f]]));
  if (fields.includes('url') && !('url' in pr)) view.url = `https://github.com/o/r/pull/${number}`;
  if (left > 0) Object.assign(view, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  process.stdout.write(`${JSON.stringify(view)}\n`);
} else if (action === 'edit') {
  process.stderr.write('GraphQL: Projects (classic) is being deprecated in favor of the new Projects experience, see: https://github.blog/changelog/2024-05-23-sunset-notice-projects-classic/. (repository.pullRequest.projectCards)\n');
  code = 1;
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

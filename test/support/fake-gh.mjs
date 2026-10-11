#!/usr/bin/env node
// Fake `gh` for the `apv stack` tests (APV_GH). State in the JSON file named by FAKE_GH_STATE (`comments`: bodies of the
// comments of each pull request, read by the merge on order):
// { prs: { "<n>": { ...gh pr view fields } }, behavior: { retargetIgnored: [n], retargetFail: [n], mergeFail: [n],
//   headMovesAtMerge: [n], unknownViews: { "<n>": count }, afterMerge: { "<n>": { "<m>": { ...fields } } },
//   behind: { "<n>": { "<base>": { ahead_by, files, listed, merges } } }, compareFail: [n],
//   afterMergeBehind: { "<n>": { "<m>": { "<base>": { ...compare } } } }, pendingViews: { "<n>": count }, liveHeads: [n] }, calls: [[...args]] }.
// `liveHeads`: the head of PR n is read from its branch of `origin` at each call (a branch the batch updated).
// `pendingViews`: the next `count` reads of PR n show its CI still running (a check IN_PROGRESS, state BLOCKED).
// The repository is o/r on github.com. The retarget goes through `gh api -X PATCH repos/o/r/pulls/<n> -f base=<b>`;
// `gh pr edit` fails as it did on the real merge of PR #70 and #71 (deprecated classic projects).
// `gh api repos/o/r/compare/<head sha>...<base> --jq …` answers the object the jq filter builds, from `behind` for the
// PR with that head (up to date by default: ahead_by 0, no file).
// With `origin` (path of a bare repository), `pr merge --merge` makes the real merge commit there (the batch tests of
// `apv stack batch`); `behavior.alterAfterMerge: [n]` then adds a commit that changes a file on the base (a merge whose
// content differs), `behavior.pushOnView: { "<n>": k }` pushes such a commit on the base at the k-th read of PR n.
// Branches (cleanup after the merges): `repo` ({ default_branch, delete_branch_on_merge }, main and false by default)
// answers `gh api repos/o/r`; `gh api repos/o/r/branches/<b>` gives { sha, protected } from `branches` ({ "<b>": { sha,
// protected } | null }, null for deleted), else from the head of the PR of that branch (not a fork), else the default
// branch; with `origin`, from the refs of that bare repository. `gh api -X GET repos/o/r/pulls -f state=open -f base=<b>`
// (or `head=o:<b>`; `state=all`: any state) lists the PRs; `gh auth status --hostname <h>` succeeds for github.com and `authHosts`; `gh api -X DELETE repos/o/r/git/refs/heads/<b>` deletes the branch. Behaviors:
// `protected: [b]`, `repoFail`, `branchReadFail: [b]`, `pullsFail`, `deleteFail: [b]` (403), `deleteIgnored: [b]` (code 0,
// branch kept), `signalOnMerge: [n]` (SIGINT to the caller after the merge of PR n); with `repo.delete_branch_on_merge`, a merge deletes the head branch as GitHub does.
import { execFileSync } from 'node:child_process';
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
// `liveHeads: [n]`: the head of PR n is read from its branch in `origin` (the batch pushed an update to it), as GitHub does.
if (pr && state.origin && state.behavior.liveHeads?.includes(Number(number))) {
  try { pr.headRefOid = execFileSync('git', ['rev-parse', `refs/heads/${pr.headRefName}`], { cwd: state.origin, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* branch gone: the recorded head */ }
}
const originGit = (...a) => execFileSync('git', a, { cwd: state.origin, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'gh@localhost', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'gh@localhost' } }).trim();
/** A commit on `branch` of the origin that changes one file: someone else pushed. */
function externalPush(branch, label) {
  const head = originGit('rev-parse', `refs/heads/${branch}`);
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: state.origin, input: `${label}\n`, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['mktree'], { cwd: state.origin, input: `${originGit('ls-tree', head)}\n100644 blob ${blob}\texternal-${label}.txt\n`, encoding: 'utf8' }).trim();
  const commit = originGit('commit-tree', tree, '-p', head, '-m', `external ${label}`);
  originGit('update-ref', `refs/heads/${branch}`, commit, head);
}
const repoSettings = () => ({ default_branch: 'main', fork: false, delete_branch_on_merge: false, ...state.repo });
/** The branch `name` of o/r: { sha, protected }, or null when it does not exist. */
function branchOf(name) {
  const isProtected = state.behavior.protected?.includes(name) ?? false;
  if (state.origin) {
    try { return { sha: originGit('rev-parse', '--verify', '--quiet', `refs/heads/${name}`), protected: isProtected }; } catch { return null; }
  }
  if (state.branches && name in state.branches) return state.branches[name] && { protected: isProtected, ...state.branches[name] };
  const owner = Object.values(state.prs).find(p => p.headRefName === name && p.isCrossRepository !== true);
  if (owner) return { sha: owner.headRefOid, protected: isProtected };
  return name === repoSettings().default_branch ? { sha: 'd'.repeat(40), protected: isProtected } : null;
}
function deleteBranch(name) {
  if (state.origin) originGit('update-ref', '-d', `refs/heads/${name}`);
  else { state.branches ??= {}; state.branches[name] = null; }
}
const field = name => args.find((a, k) => args[k - 1] === '-f' && a.startsWith(`${name}=`))?.slice(name.length + 1);
const restPath = args.find(a => a.startsWith('repos/')) ?? '';
const method = option('-X') ?? 'GET';
const compare = /^repos\/o\/r\/compare\/([^.]+)\.\.\.(.+)$/.exec(args.find(a => a.startsWith('repos/')) ?? '');
if (group === 'api' && compare) {
  const [, head, base] = compare;
  const owner = Object.values(state.prs).find(p => p.headRefOid === head);
  if (!args.includes('--jq')) { process.stderr.write('fake gh: compare without --jq\n'); code = 1; }
  else if (!owner) { process.stderr.write('gh: Not Found (HTTP 404)\n'); code = 1; }
  else if (state.behavior.compareFail?.includes(owner.number)) { process.stderr.write('gh: Server Error (HTTP 502)\n'); code = 1; }
  else {
    const found = state.behavior.behind?.[owner.number]?.[decodeURIComponent(base)] ?? { ahead_by: 0, files: [] };
    const answer = { ahead_by: found.ahead_by, merge_base: 'b'.repeat(40), listed: found.listed ?? found.ahead_by, merges: found.merges ?? 0, files: found.files };
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  }
} else if (group === 'api' && /^repos\/o\/r\/issues\/\d+\/comments$/.test(restPath) && method === 'GET') {
  // Comments of a pull request (merge on order): `comments: { "<n>": [body...] }`, one JSON string per line, as
  // `gh api --paginate ... --jq '.[] | .body | @json'` writes them.
  const n = restPath.split('/')[4];
  if (!args.includes('--paginate') || option('--jq') !== '.[] | .body | @json') { process.stderr.write('fake gh: comments read without --paginate or the expected --jq\n'); code = 1; }
  else for (const body of state.comments?.[n] ?? []) process.stdout.write(`${JSON.stringify(body)}\n`);
} else if (group === 'api' && restPath === 'repos/o/r' && method === 'GET') {
  if (state.behavior.repoFail) { process.stderr.write('gh: Server Error (HTTP 500)\n'); code = 1; }
  else {
    const repo = repoSettings();
    process.stdout.write(`${JSON.stringify({ default_branch: repo.default_branch, fork: repo.fork ?? null, delete_branch_on_merge: repo.delete_branch_on_merge ?? null })}\n`);
  }
} else if (group === 'api' && /^repos\/o\/r\/branches\/./.test(restPath) && method === 'GET') {
  const name = decodeURIComponent(restPath.slice('repos/o/r/branches/'.length));
  const branch = branchOf(name);
  if (!args.includes('--jq')) { process.stderr.write('fake gh: branch read without --jq\n'); code = 1; }
  else if (state.behavior.branchReadFail?.includes(name)) { process.stderr.write('gh: Server Error (HTTP 502)\n'); code = 1; }
  else if (!branch) { process.stdout.write('{"message":"Branch not found","status":"404"}'); process.stderr.write('gh: Branch not found (HTTP 404)\n'); code = 1; }
  else process.stdout.write(`${JSON.stringify({ sha: branch.sha, protected: branch.protected })}\n`);
} else if (group === 'api' && restPath === 'repos/o/r/pulls' && method === 'GET') {
  const [base, head] = [field('base'), field('head')];
  if (state.behavior.pullsFail) { process.stderr.write('gh: Server Error (HTTP 500)\n'); code = 1; }
  else if (!['open', 'all'].includes(field('state')) || (base === undefined) === (head === undefined)) { process.stderr.write('fake gh: unexpected pulls query\n'); code = 1; }
  else {
    const open = Object.values(state.prs).filter(p => (field('state') === 'all' || p.state === 'OPEN') &&
      (base !== undefined ? p.baseRefName === base : p.isCrossRepository !== true && `o:${p.headRefName}` === head));
    process.stdout.write(`${JSON.stringify(open.map(p => p.number))}\n`);
  }
} else if (group === 'api' && /^repos\/o\/r\/git\/refs\/heads\/./.test(restPath) && method === 'DELETE') {
  const name = decodeURIComponent(restPath.slice('repos/o/r/git/refs/heads/'.length));
  if (state.behavior.deleteFail?.includes(name)) { process.stderr.write('gh: Resource not accessible by integration (HTTP 403)\n'); code = 1; }
  else if (!branchOf(name)) { process.stderr.write('gh: Reference does not exist (HTTP 422)\n'); code = 1; }
  else if (!state.behavior.deleteIgnored?.includes(name)) deleteBranch(name);
} else if (group === 'api') {
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
} else if (group === 'auth' && action === 'status') {
  // Hosts gh is logged in to: github.com and `authHosts`.
  const host = option('--hostname') ?? 'github.com';
  if (host === 'github.com' || state.authHosts?.includes(host)) process.stdout.write(`${host}\n  ✓ Logged in to ${host}\n`);
  else { process.stderr.write(`You are not logged into any accounts on ${host}\n`); code = 1; }
} else if (group !== 'pr' || !pr) {
  process.stderr.write(`no pull requests found for ${number}\n`);
  code = 1;
} else if (action === 'view') {
  state.views ??= {};
  state.views[number] = (state.views[number] ?? 0) + 1;
  if (state.origin && state.behavior.pushOnView?.[number] === state.views[number]) externalPush(pr.baseRefName, `view-${number}`);
  const left = state.behavior.unknownViews?.[number] ?? 0;
  if (left > 0) state.behavior.unknownViews[number] = left - 1;
  const fields = option('--json').split(',');
  const view = Object.fromEntries(fields.filter(f => f in pr).map(f => [f, pr[f]]));
  if (fields.includes('url') && !('url' in pr)) view.url = `https://github.com/o/r/pull/${number}`;
  if (fields.includes('isCrossRepository') && !('isCrossRepository' in pr)) view.isCrossRepository = false;
  if (left > 0) Object.assign(view, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  // The CI still runs for the next `pendingViews[n]` reads (--wait-ci).
  const running = state.behavior.pendingViews?.[number] ?? 0;
  if (running > 0) {
    state.behavior.pendingViews[number] = running - 1;
    Object.assign(view, { statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: '' }], mergeStateStatus: 'BLOCKED' });
  }
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
    if (state.origin) {
      const base = originGit('rev-parse', `refs/heads/${pr.baseRefName}`);
      const tree = originGit('merge-tree', '--write-tree', base, pr.headRefOid);
      const merged = originGit('commit-tree', tree, '-p', base, '-p', pr.headRefOid, '-m', `Merge pull request #${number} from ${pr.headRefName}`);
      originGit('update-ref', `refs/heads/${pr.baseRefName}`, merged, base);
      if (state.behavior.alterAfterMerge?.includes(Number(number))) externalPush(pr.baseRefName, `after-${number}`);
    }
    pr.state = 'MERGED';
    // The operator presses Ctrl-C right after this merge: SIGINT to the tool that called gh.
    if (state.behavior.signalOnMerge?.includes(Number(number))) process.kill(process.ppid, 'SIGINT');
    if (repoSettings().delete_branch_on_merge && branchOf(pr.headRefName)) deleteBranch(pr.headRefName);
    for (const [other, fields] of Object.entries(state.behavior.afterMerge?.[number] ?? {})) Object.assign(state.prs[other], fields);
    for (const [other, bases] of Object.entries(state.behavior.afterMergeBehind?.[number] ?? {})) {
      state.behavior.behind ??= {};
      state.behavior.behind[other] = { ...state.behavior.behind[other], ...bases };
    }
    process.stdout.write(`✓ Merged pull request o/r#${number} (${pr.headRefName})\n`);
  }
} else { process.stderr.write(`unknown command ${action}\n`); code = 1; }
save();
process.exitCode = code;

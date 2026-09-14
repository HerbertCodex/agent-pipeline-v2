# 2.0.0-alpha.4

## Empty-repository bootstrap

`apv2 bootstrap` closes the gap between cloning an empty application repository and installing Agent Pipeline.

- Setup proposes a bounded structured file manifest; it does not edit the target.
- Empty Git repositories and truly empty directories are accepted. Existing projects are refused and must use `onboard`.
- Absolute paths, `.git`, path escapes, duplicates, more than 200 files and more than 2 MiB of proposed UTF-8 content are rejected.
- `bootstrap apply` requires the exact hash, a real reviewer/note and `--commit`.
- The controller writes only approved files, creates the first commit, then immediately creates the normal onboarding plan.
- Dependency installation and project commands remain outside bootstrap and require the later `doctor --execute` authorization.

## Validation

Local validation on Node 22.16.0/Linux:

- TypeScript compilation passed.
- 280 tests passed, 0 failed/skipped/cancelled.
- Offline npm artifact check passed.
- Existing deterministic demos passed.
- A native Codex-protocol double exercised the CLI bootstrap path and confirmed no target writes occur before approval.

No authenticated Codex or Claude call is claimed by these tests.

# Skills shipped with Agent Pipeline V2

These six families are adapted from the user-supplied `agent-pipeline-main.zip` (V1 archive, version declared 0.6.3). This is not a claim of byte-for-byte identity with the v0.6.3 tag. Original project: HerbertCodex/agent-pipeline, MIT. Main instructions are revised for the V2 execution model; The current catalog includes 42 supporting reference/checklist files, including the added OWASP and AI-agent security references.

Run `node dist/cli.js skills list` from the framework root. Each directory has a portable `SKILL.md`; `manifest.json` holds the pipeline's deterministic role, project-type and keyword routing. No skill executes scripts, grants permissions, enforces quality or creates another agent. The pipeline injects only selected short SKILL.md bodies; supporting files are installed for on-demand reading. No claim is made that a provider actually read a reference merely because it was available.

See [configuration and discovery](../docs/SKILLS.md).

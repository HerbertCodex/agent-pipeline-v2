import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { catalog, guidanceFor, installedAssets, readRole } from './catalog.js';
import { roleNames } from '../domain/knowledge.js';
import { invariant } from '../domain/errors.js';
import { parseJson } from '../domain/schema.js';
import { validateConfig } from '../domain/contracts.js';
import { providerProfile, providerSupport, executableAvailability } from '../adapters/providers.js';
import { Git } from '../execution/git.js';
export const knowledgeHelp = `Discovery (no model call, no project script, no approval):
  apv2 roles [ROLE]                      List roles or read their actual runtime instructions
  apv2 skills list                       List shipped skills, routing and reference files
  apv2 skills show ID                    Read a shipped SKILL.md
  apv2 skills resolve --config FILE --role ROLE --request TEXT
  apv2 providers                        Show native/protocol support and local executable presence
  apv2 inspect --repo PATH [--config FILE] Show effective roles/providers/skills and installed-file drift
`;
function configFile(path) {
    const text = readFileSync(path, 'utf8');
    invariant(Buffer.byteLength(text) <= 2000000, 'INPUT_SIZE', 'Configuration exceeds 2 MB');
    return validateConfig(parseJson(text));
}
export async function knowledgeCommand(command, args, values) {
    const str = (key) => typeof values[key] === 'string' ? values[key] : undefined;
    if (command === 'roles') {
        const role = args[1];
        if (role && role !== 'list') {
            invariant(roleNames.includes(role), 'ROLE', `Unknown role: ${role}`);
            process.stdout.write(readRole(role).instructions);
        }
        else
            console.log(JSON.stringify({ roles: roleNames.map(r => { const { instructions: _, ...info } = readRole(r); return { ...info, execution: r === 'implementer' ? 'write' : 'read-only' }; }), orchestrator: 'Deterministic TypeScript engine; not a fifth agent.' }, null, 2));
        return;
    }
    if (command === 'providers') {
        invariant(!args[1], 'ARGUMENT', 'Use apv2 providers');
        console.log(JSON.stringify({ note: 'Executable presence is not authentication or a successful model pilot. The UI assistant and role executors are separate choices.', providers: providerSupport.map(p => ({ ...p, local: p.id === 'command' ? null : executableAvailability(providerProfile(p.id), process.cwd()) })) }, null, 2));
        return;
    }
    if (command === 'skills') {
        const action = args[1] ?? 'list';
        if (action === 'list')
            console.log(JSON.stringify(catalog().map(({ instructions: _, ...s }) => s), null, 2));
        else if (action === 'show') {
            const skill = catalog().find(s => s.id === args[2]);
            invariant(skill, 'SKILLS', 'Unknown skill');
            process.stdout.write(skill.instructions);
        }
        else if (action === 'resolve') {
            const role = str('role');
            invariant(role && roleNames.includes(role), 'ROLE', 'Supply --role setup|product|implementer|qa');
            invariant(str('config'), 'ARGUMENT', 'Supply --config FILE');
            console.log(JSON.stringify(guidanceFor(role, configFile(resolve(str('config'))).skills, str('request') ?? ''), null, 2));
        }
        else
            throw new Error('Use skills list, show ID or resolve');
        return;
    }
    const repo = await new Git().root(resolve(str('repo') ?? '.'));
    const path = resolve(str('config') ?? join(repo, 'pipeline.v2.json'));
    if (!existsSync(path)) {
        console.log(JSON.stringify({ repo, installed: false, next: 'Choose a provider with apv2 providers, then onboard --repo PATH --provider codex|claude. Review and approve the exact plan.', roles: roleNames, skillCatalog: catalog().map(s => s.id) }, null, 2));
        return;
    }
    const config = configFile(path);
    const roles = roleNames.map(role => {
        const agent = role === 'product' ? config.roles.product ?? config.agent : role === 'qa' ? config.roles.qa ?? config.agent : config.agent;
        return { role, provider: agent.type, model: agent.model || 'provider default', local: executableAvailability(agent, repo), instructions: readRole(role).path,
            note: role === 'setup' ? 'Default for future setup; an explicit --agent/--provider can override the installation invocation.' : '' };
    });
    const drift = installedAssets(config.skills).flatMap(file => {
        let cursor = repo;
        for (const part of file.path.split('/')) {
            cursor = join(cursor, part);
            try {
                if (lstatSync(cursor).isSymbolicLink())
                    return [{ path: file.path, status: 'symlink-refused' }];
            }
            catch {
                return [{ path: file.path, status: 'missing' }];
            }
        }
        const st = lstatSync(cursor);
        if (!st.isFile() || st.size > 131072)
            return [{ path: file.path, status: 'invalid-file' }];
        return readFileSync(cursor, 'utf8') === file.content ? [] : [{ path: file.path, status: 'different-from-package' }];
    });
    console.log(JSON.stringify({ repo, installed: true, config: path, roles, skills: config.skills, drift,
        note: 'No provider or gate was run. Skill/role copies in the project are reference material; the trusted package supplies runtime instructions. Drift is diagnostic, not silently overwritten.',
        next: drift.length ? 'Review docs/MIGRATION.md; preserve local edits and do not regenerate blindly.' : 'Review configuration; doctor --execute requires separate permission for setup and tests.' }, null, 2));
}
//# sourceMappingURL=cli.js.map
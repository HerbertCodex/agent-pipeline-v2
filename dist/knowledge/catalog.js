import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, hash } from '../domain/hash.js';
import { invariant } from '../domain/errors.js';
import { s, parseJson } from '../domain/schema.js';
import { roleNames, skillNames, projectTypes, skillsSchema } from '../domain/knowledge.js';
export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const entrySchema = s.object({
    id: s.enum(skillNames), roles: s.array(s.enum(roleNames), 1, 4),
    projectTypes: s.array(s.enum(projectTypes), 0, 6),
    keywords: s.array(s.string(1, 100), 0, 100), resources: s.array(s.string(1, 300), 0, 100),
});
const manifestSchema = s.object({ schemaVersion: s.literal(1), skills: s.array(entrySchema, 6, 6) });
/** Only read bounded regular package files. No glob expansion, executable config or user-selected roots. */
export function asset(path) {
    invariant(path.split('/').every(p => p && p !== '.' && p !== '..') && !path.includes('\\'), 'ASSET_PATH', 'Invalid asset path');
    let current = packageRoot;
    for (const part of path.split('/')) {
        current = join(current, part);
        invariant(!lstatSync(current).isSymbolicLink(), 'ASSET_PATH', `Symlink asset refused: ${path}`);
    }
    const st = lstatSync(current);
    invariant(st.isFile() && st.size > 0 && st.size <= 131072, 'ASSET_SIZE', `Invalid asset: ${path}`);
    const text = readFileSync(current, 'utf8');
    invariant(!text.includes('\0'), 'ASSET', `Invalid text asset: ${path}`);
    return text;
}
export function readRole(role) {
    invariant(roleNames.includes(role), 'ROLE', 'Unknown role');
    const path = `roles/${role}.md`;
    const instructions = asset(path);
    return { id: role, path, instructions, sha256: sha256(instructions) };
}
export function catalog() {
    const manifest = manifestSchema.parse(parseJson(asset('skills/manifest.json')));
    invariant(new Set(manifest.skills.map(s => s.id)).size === skillNames.length, 'SKILLS', 'Duplicate or missing skill');
    return manifest.skills.map(entry => {
        const path = `skills/${entry.id}/SKILL.md`;
        const instructions = asset(path);
        const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(instructions)?.[1];
        invariant(header && /^name: (.+)$/m.exec(header)?.[1] === entry.id, 'SKILL_METADATA', `Invalid name: ${path}`);
        const description = /^description: (.+)$/m.exec(header)?.[1];
        invariant(description && description.length <= 1024, 'SKILL_METADATA', `Missing description: ${path}`);
        const resources = entry.resources.map(relative => {
            invariant(/^(references|assets)\/[a-z0-9-]+\.md$/.test(relative), 'SKILL_RESOURCE', 'Only bounded Markdown references are shipped');
            const resourcePath = `skills/${entry.id}/${relative}`;
            return { path: resourcePath, sha256: sha256(asset(resourcePath)) };
        });
        invariant(new Set(entry.resources).size === entry.resources.length, 'SKILLS', 'Duplicate resource');
        return { ...entry, resources, path, description, instructions, sha256: sha256(instructions), bundleHash: hash({ instructions, resources }) };
    });
}
/** Deterministic selection; no model call and no workflow node. Full references are not inlined. */
export function guidanceFor(role, input, taskText = '') {
    const config = skillsSchema.parse(input ?? {});
    invariant(new Set(config.enabled).size === config.enabled.length, 'SKILLS', 'Duplicate enabled skill');
    const roleInfo = readRole(role);
    const selected = [];
    const skipped = [];
    const text = taskText.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    let bytes = 0;
    for (const skill of catalog()) {
        let reason = '';
        if (!config.enabled.includes(skill.id))
            reason = 'disabled';
        else if (!skill.roles.includes(role))
            reason = 'role';
        else if (skill.projectTypes.length && !skill.projectTypes.includes(config.projectType))
            reason = 'project-type';
        else if (skill.keywords.length && !skill.keywords.some(k => text.includes(k)))
            reason = 'task';
        const size = Buffer.byteLength(skill.instructions);
        if (!reason && bytes + size > config.maxContextBytes)
            reason = 'context-budget';
        if (reason) {
            skipped.push({ id: skill.id, reason });
            continue;
        }
        bytes += size;
        selected.push({ id: skill.id, description: skill.description, instructions: skill.instructions, sha256: skill.sha256,
            bundleHash: skill.bundleHash, referenceFiles: skill.resources.map(r => `.agent-pipeline/${r.path}`) });
    }
    return { role: roleInfo, skills: selected, skipped, bytes,
        digest: hash({ role: roleInfo.sha256, skills: selected.map(s => s.bundleHash), config }),
        note: 'Skills are advice, not policy or permission. Only short instructions are injected; reference files are available after onboarding. Injection is not proof that the model used them. Existing gates remain authoritative.' };
}
export function guidanceAudit(g) {
    return { digest: g.digest, role: { id: g.role.id, sha256: g.role.sha256 }, bytes: g.bytes,
        skills: g.skills.map(({ id, sha256, bundleHash }) => ({ id, sha256, bundleHash })), skipped: g.skipped };
}
export function installedAssets(input) {
    const config = skillsSchema.parse(input);
    return [
        ...roleNames.map(r => ({ path: `.agent-pipeline/roles/${r}.md`, content: readRole(r).instructions })),
        ...catalog().filter(s => config.enabled.includes(s.id) && (!s.projectTypes.length || s.projectTypes.includes(config.projectType)))
            .flatMap(s => [s.path, ...s.resources.map(r => r.path)].map(path => ({ path: `.agent-pipeline/${path}`, content: asset(path) }))),
    ];
}
//# sourceMappingURL=catalog.js.map
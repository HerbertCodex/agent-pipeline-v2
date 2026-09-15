import { environment, runProcess } from '../execution/process.js';
import { invariant } from '../domain/errors.js';
import { extensionOf, isExported, isTestPath, nonSourceExtensions, resolveLanguages } from './languages.js';
const MAX_FILES = 50000;
const MAX_SYMBOLS = 20000;
const MAX_LINE = 2000;
const PATHSPEC_CHUNK = 1000;
const GREP_BYTES = 32 * 1024 * 1024;
function stripRev(entry, sha) { return entry.startsWith(`${sha}:`) ? entry.slice(sha.length + 1) : entry; }
async function grep(repo, sha, args, paths, signal) {
    const env = environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'LANG']);
    const rows = [];
    for (let i = 0; i < paths.length; i += PATHSPEC_CHUNK) {
        const result = await runProcess({ command: ['git', '-c', 'core.quotePath=false', 'grep', '-I', '--null', ...args, sha, '--', ...paths.slice(i, i + PATHSPEC_CHUNK).map(p => `:(literal)${p}`)],
            cwd: repo, env, timeoutMs: 120000, ...(signal ? { signal } : {}), maxOutputBytes: GREP_BYTES });
        // Exit 1 only means no match in this chunk.
        invariant(result.status === 'passed' || result.exitCode === 1, 'REPOSITORY_INDEX', 'Repository inventory scan failed');
        invariant(!result.truncated, 'REPOSITORY_INDEX', 'Repository inventory output exceeds the alpha indexing limit');
        rows.push(...result.stdout.split(args.includes('-l') ? '\0' : '\n').filter(Boolean));
    }
    return rows;
}
/**
 * Deterministic, model-free inventory of an immutable Git tree. Languages are recognised by
 * declarative profiles (extension + declaration grammar); every other text source file becomes
 * a file-level unit so that no technology is invisible and none needs a controller special case.
 */
export async function buildInventory(repo, ref, options = {}) {
    const env = environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'LANG']);
    const resolved = await runProcess({ command: ['git', 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], cwd: repo, env, timeoutMs: 10000, ...(options.signal ? { signal: options.signal } : {}) });
    invariant(resolved.status === 'passed', 'REPOSITORY_INDEX', `Unknown commit: ${ref}`);
    const sha = resolved.stdout.trim();
    const tree = await runProcess({ command: ['git', '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', '-z', sha], cwd: repo, env, timeoutMs: 30000, ...(options.signal ? { signal: options.signal } : {}), maxOutputBytes: 8 * 1024 * 1024 });
    invariant(tree.status === 'passed' && !tree.truncated, 'REPOSITORY_INDEX', 'Unable to enumerate repository');
    const files = tree.stdout.split('\0').filter(Boolean);
    invariant(files.length <= MAX_FILES, 'REPOSITORY_INDEX', 'Repository file count exceeds alpha indexing limit');
    const languages = resolveLanguages(options.languages);
    const byExtension = new Map(languages.flatMap(l => l.profile.extensions.map(x => [x, l])));
    const symbols = [];
    const languageCounts = [];
    let truncated = false;
    for (const language of languages) {
        const paths = files.filter(f => { const x = extensionOf(f); return x !== null && byExtension.get(x) === language; });
        if (!paths.length)
            continue;
        languageCounts.push({ id: language.profile.id, files: paths.length });
        for (const row of await grep(repo, sha, ['-n', '-E', language.profile.prefilter], paths, options.signal)) {
            const [entry, lineText, ...rest] = row.split('\0');
            const text = rest.join('\0');
            if (!entry || !lineText || text.length > MAX_LINE)
                continue;
            const path = stripRev(entry, sha);
            for (const declaration of language.declarations) {
                const match = declaration.regex.exec(text);
                const name = match?.groups?.name;
                if (!match || !name)
                    continue;
                if (symbols.length >= MAX_SYMBOLS) {
                    truncated = true;
                    break;
                }
                symbols.push({ name, kind: declaration.kind, path, line: Number(lineText), exported: isExported(declaration.exported, name, match.groups ?? {}), language: language.profile.id, test: isTestPath(path) });
                break;
            }
        }
    }
    const unitCandidates = files.filter(f => {
        const x = extensionOf(f);
        const base = f.slice(f.lastIndexOf('/') + 1);
        return x !== null && !base.startsWith('.') && !byExtension.has(x) && !nonSourceExtensions.has(x);
    });
    const textUnits = unitCandidates.length ? new Set((await grep(repo, sha, ['-l', '-e', ''], unitCandidates, options.signal)).map(e => stripRev(e, sha))) : new Set();
    const units = unitCandidates.filter(p => textUnits.has(p)).map(path => {
        const base = path.slice(path.lastIndexOf('/') + 1);
        const extension = extensionOf(path);
        return { name: base.slice(0, base.length - extension.length - 1), path, extension, test: isTestPath(path) };
    });
    symbols.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    units.sort((a, b) => a.path.localeCompare(b.path));
    return { sha, fileCount: files.length, files, languages: languageCounts, unitExtensions: [...new Set(units.map(u => u.extension))].sort(), symbols, units, truncated };
}
/** Compact, bounded view handed to agents: the full public surface, not a lexical sample. */
export function inventoryForAgents(inventory, maxSymbols = 1500, maxUnits = 1000) {
    const exported = inventory.symbols.filter(x => x.exported && !x.test);
    const units = inventory.units.filter(x => !x.test);
    return {
        sha: inventory.sha,
        languages: inventory.languages,
        unitExtensions: inventory.unitExtensions,
        exported: exported.slice(0, maxSymbols).map(({ name, kind, path, line }) => ({ name, kind, path, line })),
        units: units.slice(0, maxUnits).map(u => u.path),
        omitted: { exported: Math.max(0, exported.length - maxSymbols), units: Math.max(0, units.length - maxUnits), internalSymbols: inventory.symbols.filter(x => !x.exported && !x.test).length, testFiles: new Set([...inventory.symbols, ...inventory.units].filter(x => x.test).map(x => x.path)).size },
        truncated: inventory.truncated,
        note: 'Deterministic inventory of the Git tree at sha (declarations and file-level units). It lists what exists, not whether it fits: inspect a candidate before reusing it, and before creating a similar abstraction.',
    };
}
const normalized = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
/**
 * Public surface introduced by a candidate, and new names that collide (case/punctuation-insensitive)
 * with something that already existed elsewhere. A collision is a review prompt, not a verdict.
 */
export function diffInventory(base, candidate) {
    const surface = (inv) => [
        ...inv.symbols.filter(x => x.exported && !x.test).map(x => ({ name: x.name, kind: x.kind, path: x.path, line: x.line })),
        ...inv.units.filter(x => !x.test).map(x => ({ name: x.name, kind: `unit:${x.extension}`, path: x.path, line: 1 })),
    ];
    const key = (x) => `${x.path}\0${x.kind}\0${x.name}`;
    const before = surface(base);
    const after = surface(candidate);
    const beforeKeys = new Set(before.map(key));
    const afterKeys = new Set(after.map(key));
    const added = after.filter(x => !beforeKeys.has(key(x)));
    const removed = before.filter(x => !afterKeys.has(key(x))).map(({ name, kind, path }) => ({ name, kind, path }));
    const existingByName = new Map();
    for (const x of before) {
        const k = normalized(x.name);
        if (k.length >= 3)
            existingByName.set(k, [...(existingByName.get(k) ?? []), x]);
    }
    const possibleDuplicates = added.flatMap(x => (existingByName.get(normalized(x.name)) ?? []).filter(e => e.path !== x.path && afterKeys.has(key(e)))
        .map(e => ({ added: { name: x.name, kind: x.kind, path: x.path }, existing: { name: e.name, kind: e.kind, path: e.path } })));
    return { added, removed, possibleDuplicates };
}
/** Human-readable, deterministic inventory document. */
export function inventoryMarkdown(inventory) {
    const exported = inventory.symbols.filter(x => x.exported && !x.test);
    const units = inventory.units.filter(x => !x.test);
    const byPath = new Map();
    for (const x of exported)
        byPath.set(x.path, [...(byPath.get(x.path) ?? []), `\`${x.name}\` (${x.kind}, L${x.line})`]);
    for (const u of units)
        byPath.set(u.path, [...(byPath.get(u.path) ?? []), `unit \`${u.name}\``]);
    const byDir = new Map();
    for (const path of [...byPath.keys()].sort()) {
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
        byDir.set(dir, [...(byDir.get(dir) ?? []), `- \`${path}\` — ${byPath.get(path).join(', ')}`]);
    }
    const testFiles = new Set([...inventory.symbols, ...inventory.units].filter(x => x.test).map(x => x.path)).size;
    const lines = ['# Repository inventory', '',
        `Generated deterministically from Git tree \`${inventory.sha}\`, without a model. It lists what exists; architectural intent lives in the architecture document.`, '',
        `- Files: ${inventory.fileCount}`,
        `- Languages: ${inventory.languages.map(l => `${l.id} (${l.files})`).join(', ') || 'none recognised'}`,
        `- File-level units (no declaration grammar): ${inventory.unitExtensions.map(x => `.${x}`).join(', ') || 'none'}`,
        `- Public declarations: ${exported.length}; internal declarations: ${inventory.symbols.filter(x => !x.exported && !x.test).length}; test files: ${testFiles}`,
        ...(inventory.truncated ? ['- Truncated: symbol limit reached'] : []), ''];
    for (const [dir, entries] of byDir)
        lines.push(`## ${dir}`, '', ...entries, '');
    return lines.join('\n');
}
//# sourceMappingURL=inventory.js.map
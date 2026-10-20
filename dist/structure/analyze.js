import { posix } from 'node:path';
import { folderName, joinLike, parseName, related, singular, startsWith, tokenize } from './names.js';
const inside = (path, dir) => dir === '.' || path === dir || path.startsWith(`${dir}/`);
const join = (dir, name) => (dir === '.' ? name : `${dir}/${name}`);
/** The role of a module by its name: longest matching key, name suffixes first. */
function roleOf(file, roles) {
    if (file.component || file.reserved)
        return null;
    const t = file.tokens;
    for (const [key, suffix, name] of roles) {
        if (suffix) {
            if (key.length <= t.length && key.every((k, i) => t[t.length - key.length + i] === k))
                return { name, suffix: true, domain: t.slice(0, t.length - key.length) };
        }
        else {
            for (let i = 0; i + key.length <= t.length; i++)
                if (key.every((k, j) => t[i + j] === k))
                    return { name, suffix: false, domain: [] };
        }
    }
    return null;
}
/** Folder entries: one per stem, the main file first by fewest name parts, then by name. */
function entriesOf(files, roles) {
    const byStem = new Map();
    for (const f of files)
        byStem.set(f.stem, [...(byStem.get(f.stem) ?? []), f]);
    const entries = [];
    let tests = 0;
    let companions = 0;
    for (const group of byStem.values()) {
        const sources = group.filter(f => !f.test).sort((a, b) => a.infixes.length - b.infixes.length || a.name.localeCompare(b.name));
        tests += group.length - sources.length;
        if (!sources.length)
            continue;
        companions += sources.length - 1;
        const main = sources[0];
        entries.push({ main, followers: group.filter(f => f !== main), role: roleOf(main, roles) });
    }
    entries.sort((a, b) => a.main.name.localeCompare(b.main.name));
    return { entries, tests, companions };
}
/** Name of a module once moved into a folder named after `drop` words: those leading words are removed. */
function shortName(entry, drop) {
    const t = entry.main.tokens;
    let k = 0;
    while (k < t.length - 1 && drop.some(d => related(t[k], d)))
        k++;
    return k === 0 ? entry.main.stem : joinLike(entry.main.stem, t.slice(k));
}
/** Preferred spelling of a domain word among its variants: the plural (a folder holds several), else the shortest. */
function spelling(words) {
    const plural = words.filter(w => singular(w) !== w);
    const pool = plural.length ? plural : words;
    return [...pool].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}
/** Longest run of leading words shared by every name, compared with `related`. */
function commonPrefix(names) {
    let k = 0;
    while (names.every(n => k < n.length && related(n[k], names[0][k])))
        k++;
    return k;
}
/** Union-find over indices. */
function clusters(size, linked) {
    const parent = Array.from({ length: size }, (_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let a = 0; a < size; a++)
        for (let b = 0; b < size; b++)
            if (a !== b && linked(a, b))
                parent[find(a)] = find(b);
    const out = new Map();
    for (let i = 0; i < size; i++)
        out.set(find(i), [...(out.get(find(i)) ?? []), i]);
    return [...out.values()];
}
/**
 * Deterministic analysis of a list of tracked paths: findings per folder and a move plan. Pure: reads no
 * file, runs nothing, applies nothing.
 */
export function analyzeStructure(paths, settings, options = {}) {
    const kept = paths.filter(p => !settings.ignore.some(re => re.test(p)));
    const tracked = new Set(paths);
    // Directories of the tree (for sibling folders and the domain vocabulary), ignored paths left out.
    const dirs = new Set();
    for (const p of kept)
        for (let d = posix.dirname(p); d !== '.'; d = posix.dirname(d))
            dirs.add(d);
    const vocabulary = new Set([...[...dirs].map(d => posix.basename(d).toLowerCase()), ...settings.domains]);
    const known = (word) => [...vocabulary].some(v => related(v, word));
    const configured = settings.domains.map(d => d.split('-')).sort((a, b) => b.length - a.length);
    const roles = Object.entries(settings.roles)
        .map(([key, name]) => [key.replace(/^-/, '').split('-'), key.startsWith('-'), name])
        .sort((a, b) => Number(b[1]) - Number(a[1]) || b[0].length - a[0].length);
    const code = kept.map(parseName).filter((f) => f !== null && settings.roots.some(r => inside(f.path, r)));
    const byDir = new Map();
    for (const f of code)
        byDir.set(f.dir, [...(byDir.get(f.dir) ?? []), f]);
    const wanted = (dir) => !options.paths?.length || options.paths.some(p => inside(dir, p));
    const findings = [];
    const folders = [];
    const plan = [];
    const taken = new Set();
    for (const dir of [...byDir.keys()].sort()) {
        if (!wanted(dir))
            continue;
        const { entries, tests, companions } = entriesOf(byDir.get(dir), roles);
        const own = tokenize(posix.basename(dir));
        const ownWord = (w) => own.some(o => related(o, w));
        const siblings = [...dirs].filter(d => posix.dirname(d) === dir).map(d => ({ name: posix.basename(d), words: tokenize(posix.basename(d)) }));
        const flat = entries.length > settings.maxFlatFiles;
        const local = [];
        const placed = new Map();
        const free = (e) => !e.main.reserved && !placed.has(e);
        /** Records the moves of a placement (companions and tests follow their main file); returns them. */
        const place = (p) => {
            const out = [];
            for (const entry of p.entries) {
                let stem = p.rename(entry);
                const target = (s, f) => join(join(dir, p.dir), `${s}${f.name.slice(f.stem.length)}`);
                const clash = (s) => [entry.main, ...entry.followers].some(f => tracked.has(target(s, f)) || taken.has(target(s, f)));
                if (clash(stem))
                    stem = entry.main.stem;
                if (clash(stem))
                    continue;
                const moves = [entry.main, ...entry.followers].map(f => ({ from: f.path, to: target(stem, f) }));
                for (const m of moves)
                    taken.add(m.to);
                placed.set(entry, moves);
                out.push(moves[0]);
            }
            return out;
        };
        const finding = (code, files, proposal, moves) => {
            local.push({ code, severity: settings.severity[code], folder: dir, files: files.map(e => e.main.path), proposal, moves });
        };
        // stray-file: the name starts with the name of a neighbouring folder.
        for (const entry of entries) {
            if (!free(entry))
                continue;
            const sibling = siblings.filter(s => entry.main.tokens.length > s.words.length && startsWith(entry.main.tokens, s.words))
                .sort((a, b) => b.words.length - a.words.length)[0];
            if (!sibling)
                continue;
            const moves = place({ dir: sibling.name, entries: [entry], rename: e => (e.main.component ? e.main.stem : shortName(e, sibling.words)) });
            finding('stray-file', [entry], `Ranger ce fichier dans le dossier voisin ${sibling.name}/, déjà consacré à ce domaine.`, moves);
        }
        // repeated-prefix: several names start with the same domain word (singular and plural together).
        const keyOf = (e) => configured.find(d => startsWith(e.main.tokens, d) && e.main.tokens.length > d.length) ?? e.main.tokens.slice(0, 1);
        const candidates = entries.filter(free).filter(e => !ownWord(keyOf(e)[0]));
        for (const group of clusters(candidates.length, (a, b) => {
            const x = keyOf(candidates[a]);
            const y = keyOf(candidates[b]);
            return x.length === y.length && x.every((w, i) => related(w, y[i]));
        })) {
            const members = group.map(i => candidates[i]);
            if (members.length < 2)
                continue;
            const components = members.some(e => e.main.component);
            const key = keyOf(members[0]);
            const isConfigured = key.length > 1 || settings.domains.some(d => related(d, key[0]));
            const roled = members.filter(e => e.role?.suffix).length;
            const qualifies = components ? flat && members.length >= 3 : isConfigured || known(key[0]) || roled >= 2 || members.length >= 3;
            if (!qualifies)
                continue;
            const words = key.length > 1 ? key : [spelling(members.map(e => e.main.tokens[0])), ...members[0].main.tokens.slice(1, commonPrefix(members.map(e => e.main.tokens)))];
            const name = components ? words.join('-') : folderName(words, members[0].main.stem);
            // Components keep their names, and so do the modules grouped with them (`Menu.svelte`, `menu-context.ts`).
            const moves = place({ dir: name, entries: members, rename: e => (components ? e.main.stem : shortName(e, words)) });
            finding('repeated-prefix', members, components
                ? `Créer ${name}/ et y ranger ces ${members.length} fichiers, noms inchangés (le préfixe des composants est leur convention de nommage).`
                : `Créer ${name}/ et y ranger ces ${members.length} fichiers sans leur préfixe.`, moves);
        }
        // mixed-roles: files of several roles (actions, data access, HTTP...) for several domains side by side.
        const modules = entries.filter(e => !e.main.reserved && !e.main.component);
        const roleNames = [...new Set(modules.filter(e => e.role).map(e => e.role.name))].sort();
        const domainKeys = new Set(modules.filter(e => e.role?.suffix && e.role.domain.length && !ownWord(e.role.domain[0])).map(e => e.role.domain.map(singular).join('-')));
        // At least three files with a role, two roles and two domains: two lone files are not yet a pattern.
        const mixed = modules.filter(e => e.role).length >= 3 && roleNames.length >= 2 && domainKeys.size >= 2;
        const mixedMoves = [];
        const flatMoves = [];
        if (mixed || flat) {
            const units = [];
            if (mixed) {
                for (const e of modules.filter(free)) {
                    if (!e.role?.suffix || !e.role.domain.length || ownWord(e.role.domain[0]))
                        continue;
                    const unit = units.find(u => u.words.length === e.role.domain.length && u.words.every((w, i) => related(w, e.role.domain[i])));
                    if (unit)
                        unit.entries.push(e);
                    else
                        units.push({ words: e.role.domain, entries: [e], roled: true });
                }
                // A plain file named after a role domain joins it (`settings-defaults` with `settings-repository`).
                for (const e of modules.filter(free)) {
                    if (e.role || units.some(u => u.entries.includes(e)))
                        continue;
                    const unit = units.find(u => e.main.tokens.length > u.words.length && startsWith(e.main.tokens, u.words));
                    if (unit)
                        unit.entries.push(e);
                }
            }
            for (const e of modules.filter(free)) {
                if (e.role || e.main.tokens.length < 2 || units.some(u => u.entries.includes(e)))
                    continue;
                units.push({ words: e.main.tokens, entries: [e], roled: false });
            }
            // Compound names that chain (`account-deletion`, `deletion-purge`, `purge-schedule`) are one subject.
            const chained = (a, b) => a.words.length >= 2 && b.words.length >= 2 && related(a.words.at(-1), b.words[0]);
            for (const group of clusters(units.length, (a, b) => chained(units[a], units[b]) || chained(units[b], units[a]))) {
                const members = group.map(i => units[i]).sort((a, b) => a.words.join('-').localeCompare(b.words.join('-')));
                if (members.length < 2 && !(mixed && members[0].roled))
                    continue;
                const root = members.find(u => !members.some(v => v !== u && chained(v, u))) ?? members[0];
                const words = root.roled ? root.words : root.words.slice(0, 1);
                const sample = root.entries[0].main.stem;
                const moves = place({ dir: folderName(words, sample), entries: members.flatMap(u => u.entries), rename: e => shortName(e, words) });
                (mixed ? mixedMoves : flatMoves).push(...moves);
            }
            // Cross-cutting helpers (HTTP, authentication) of a mixed folder: one folder per role, names kept.
            if (mixed) {
                const byRole = new Map();
                for (const e of modules.filter(free))
                    if (e.role && !e.role.suffix)
                        byRole.set(e.role.name, [...(byRole.get(e.role.name) ?? []), e]);
                for (const [role, members] of [...byRole].sort()) {
                    if (members.length >= 2)
                        mixedMoves.push(...place({ dir: role, entries: members, rename: e => e.main.stem }));
                }
                const roledEntries = modules.filter(e => e.role);
                finding('mixed-roles', roledEntries, `Les rôles ${roleNames.join(', ')} se mêlent pour ${domainKeys.size} domaines : un dossier par domaine avec des noms courts (<domaine>/actions, <domaine>/repository), les utilitaires transverses regroupés par rôle.`, mixedMoves);
            }
        }
        const unplaced = entries.filter(e => !e.main.reserved && !placed.has(e)).map(e => e.main.path);
        if (flat) {
            const moved = placed.size;
            const proposal = moved
                ? `${entries.length} fichiers de code directement dans le dossier (seuil ${settings.maxFlatFiles}) : ranger par domaine selon le plan (${moved} fichier(s) placés), ${unplaced.length} fichier(s) restent à placer avec l'opérateur.`
                : `${entries.length} fichiers de code directement dans le dossier (seuil ${settings.maxFlatFiles}), sans préfixe commun ni rôle reconnu : découpage en sous-dossiers par domaine à décider avec l'opérateur (ou relever structure.maxFlatFiles).`;
            local.unshift({ code: 'flat-folder', severity: settings.severity['flat-folder'], folder: dir, files: entries.map(e => e.main.path), proposal, moves: flatMoves });
        }
        if (!local.length)
            continue;
        findings.push(...local);
        folders.push({ folder: dir, code: entries.length, tests, companions, unplaced: flat || mixed ? unplaced : [] });
        for (const moves of placed.values())
            plan.push(...moves);
    }
    plan.sort((a, b) => a.from.localeCompare(b.from));
    return {
        ok: !findings.some(f => f.severity === 'error'),
        analyzedFiles: code.length,
        maxFlatFiles: settings.maxFlatFiles,
        folders,
        findings,
        plan,
    };
}
//# sourceMappingURL=analyze.js.map
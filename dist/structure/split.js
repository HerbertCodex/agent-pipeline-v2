import { posix } from 'node:path';
import { routeOf } from '../knowledge/code-map.js';
import { parseName, related, tokenize } from './names.js';
/** Folder names that say nothing of a feature: never a group name. */
const GENERIC = new Set(['src', 'lib', 'app', 'apps', 'components', 'component', 'ui', 'shared', 'common', 'utils', 'util', 'helpers', 'server', 'client',
    'routes', 'pages', 'core', 'base', 'misc', 'internal', 'pkg', 'modules', 'features', 'tests', 'test', 'index', 'main', 'types', 'api', 'svelte', 'ts']);
/** Folders of shared building blocks: their files are used everywhere, a group is named by what the files are, never by who uses them. */
const SHARED_KIND = new Set(['ui', 'shared', 'common', 'components', 'primitives', 'utils', 'util', 'helpers', 'lib', 'design-system', 'elements', 'atoms']);
/** Module names that are the model of a domain by convention: they stay at its root. */
const MODEL_NAMES = new Set(['model', 'models', 'types', 'type', 'schema', 'schemas', 'constants', 'domain', 'entities']);
/** Words that never name a group: too common in names. */
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'get', 'set', 'is', 'has', 'to', 'of', 'in', 'on', 'a', 'an', 'new', 'use', 'make', 'create', 'build', 'default', 'type', 'types', 'props', 'data', 'value', 'values', 'item', 'items']);
const dirOf = (path) => posix.dirname(path);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const kebab = (tokens) => tokens.join('-');
function cosine(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const [k, v] of a) {
        na += v * v;
        const w = b.get(k);
        if (w !== undefined)
            dot += v * w;
    }
    for (const v of b.values())
        nb += v * v;
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
/** What a consumer file says of its use: the route it serves (first two segments), or its folder. */
function consumerContext(path) {
    const route = routeOf(path);
    if (route) {
        const segments = route.route.split('/').filter(Boolean);
        // The most specific segment that names something (`/orders/[id]/invoice`: invoice), parameters and groups apart.
        const named = segments.filter(seg => !/^[([@+_.]/.test(seg));
        return { key: `route:/${segments.slice(0, 2).join('/')}`, route: segments[0] ?? '', leaf: named.at(-1) ?? null, dir: dirOf(path) };
    }
    return { key: `dir:${dirOf(path)}`, route: null, leaf: null, dir: dirOf(path) };
}
/** Words of a name, short, stop and folder words left out. */
function words(tokens, own) {
    return tokens.filter(t => t.length > 2 && !STOP.has(t) && !own.some(o => related(o, t)));
}
/**
 * Proposes subfolders for the entries of `folder`. Pure and deterministic: the same entries and graph give the same
 * groups, in the same order, with the same names.
 */
export function proposeSplit(folder, entries, graph, context) {
    const base = posix.basename(folder);
    const own = tokenize(base);
    const sharedKind = SHARED_KIND.has(base.toLowerCase());
    const all = [...entries, ...(context.others ?? [])];
    const entryOfFile = new Map();
    for (const e of all)
        for (const f of e.files)
            entryOfFile.set(f, e);
    const isTest = (path) => parseName(path)?.test ?? false;
    const importersOfFiles = (files) => [...new Set(files.flatMap(f => graph.importers.get(f) ?? []))]
        .filter(p => !files.includes(p) && !isTest(p)).sort(byText);
    const imp = new Map(all.map(e => [e, importersOfFiles(e.files)]));
    const internalMemo = new Map();
    const internal = (e) => {
        if (!internalMemo.has(e))
            internalMemo.set(e, [...new Set(imp.get(e).map(p => entryOfFile.get(p)).filter((x) => !!x && x !== e))]);
        return internalMemo.get(e);
    };
    const external = (e) => imp.get(e).filter(p => !entryOfFile.has(p));
    // 1. Core.
    const coreMin = Math.max(3, Math.ceil(all.length / 5));
    const core = [];
    const coreSet = new Set();
    for (const e of entries) {
        const users = internal(e);
        const shown = `${users.slice(0, 3).map(u => posix.basename(u.path)).join(', ')}${users.length > 3 ? ', …' : ''}`;
        if (users.length >= coreMin) {
            coreSet.add(e);
            core.push({ path: e.path, reason: `importé par ${users.length} fichiers du dossier (${shown}) : socle du domaine, reste à sa racine` });
        }
        else if (!e.component && users.length && MODEL_NAMES.has(e.stem.toLowerCase())) {
            coreSet.add(e);
            core.push({ path: e.path, reason: `modèle du domaine par son nom, importé par ${shown} : reste à sa racine` });
        }
    }
    const pool = entries.filter(e => !coreSet.has(e));
    // 3. Anchors: existing subfolders, and the subfolders of the folders of the same domain elsewhere.
    const anchors = [];
    const childrenOf = (dir) => [...context.dirs].filter(d => dirOf(d) === dir).sort(byText);
    // Route folders are URL segments, never a code split to copy; generic names (`components`, `ui`) are no feature.
    const routeRoots = [...new Set(context.files.map(f => routeOf(f)?.root).filter((r) => !!r))];
    const inRoutes = (d) => routeRoots.some(r => d === r || d.startsWith(`${r}/`));
    const usable = (d) => !inRoutes(d) && !GENERIC.has(posix.basename(d).toLowerCase()) && !/^[([@+_.]/.test(posix.basename(d));
    for (const d of childrenOf(folder))
        if (usable(d))
            anchors.push({ name: posix.basename(d), path: d, existing: true, files: [], proposed: false });
    const mirrors = [...context.dirs].filter(d => d !== folder && posix.basename(d) === base && !inRoutes(d) && !d.startsWith(`${folder}/`) && !folder.startsWith(`${d}/`)).sort(byText);
    if (!sharedKind) {
        for (const m of mirrors) {
            for (const d of childrenOf(m))
                if (usable(d) && !anchors.some(a => a.name === posix.basename(d)))
                    anchors.push({ name: posix.basename(d), path: d, existing: false, files: [], proposed: false });
            for (const g of context.proposed?.get(m) ?? []) {
                if (anchors.some(a => a.name === g.dir))
                    continue;
                anchors.push({ name: g.dir, path: `${m}/${g.dir}`, existing: false, files: [...g.members], proposed: true });
            }
        }
    }
    for (const a of anchors)
        if (!a.proposed)
            a.files = context.files.filter(f => f.startsWith(`${a.path}/`) && !isTest(f));
    // 2. Features.
    const add = (v, key, w) => { v.set(key, (v.get(key) ?? 0) + w); };
    const raw = new Map();
    const describe = (id, files, users, tokens, links) => {
        const v = new Map();
        for (const c of users) {
            if (entryOfFile.has(c))
                continue;
            const ctx = consumerContext(c);
            add(v, ctx.key, 1);
            // Imported together by the same file.
            add(v, `by:${c}`, 0.5);
        }
        for (const l of links)
            add(v, `link:${l}`, 2);
        if (links.length)
            add(v, `link:${id}`, 2);
        for (const w of words(tokens, own))
            add(v, `word:${w}`, 1);
        const exported = new Set(files.flatMap(f => graph.exports.get(f) ?? []).flatMap(n => words(tokenize(n), own)).filter(w => w.length > 3));
        for (const w of exported)
            add(v, `word:${w}`, 0.4);
        raw.set(id, v);
    };
    const linksOf = new Map();
    for (const e of pool) {
        const links = pool.filter(x => x !== e && (internal(e).includes(x) || internal(x).includes(e)));
        linksOf.set(e, links);
        describe(e.path, e.files, imp.get(e), e.tokens, links.map(x => x.path));
    }
    for (const a of anchors) {
        // An anchor is used where its files are used, and from its own folder (`dir:<anchor>`: its files import the entry).
        const users = [...importersOfFiles(a.files).filter(p => !a.files.includes(p)), ...a.files];
        describe(`anchor:${a.path}`, a.files, users, tokenize(a.name), []);
        // The files of the anchor that import an entry of the pool: a link, as between two entries.
        const v = raw.get(`anchor:${a.path}`);
        for (const e of pool) {
            // Both ways: files of the anchor import the entry, or the entry imports files of the anchor.
            const n = imp.get(e).filter(p => a.files.includes(p)).length + a.files.filter(f => (graph.importers.get(f) ?? []).some(p => e.files.includes(p))).length;
            if (n) {
                add(v, `link:${e.path}`, 2);
                const ev = raw.get(e.path);
                add(ev, `link:anchor:${a.path}`, 2);
                if (!ev.has(`link:${e.path}`))
                    add(ev, `link:${e.path}`, 2);
                add(v, `link:anchor:${a.path}`, 2);
            }
        }
    }
    const df = new Map();
    for (const v of raw.values())
        for (const k of v.keys())
            df.set(k, (df.get(k) ?? 0) + 1);
    const n = Math.max(1, raw.size);
    const vectors = new Map();
    for (const [id, v] of raw) {
        const out = new Map();
        for (const [k, w] of v)
            if (w > 0)
                out.set(k, (1 + Math.log(w)) * Math.max(0.05, Math.log(1 + n / df.get(k))));
        vectors.set(id, out);
    }
    // 4. Average linkage, the most similar pair first; ties broken by the names. A cluster holds one anchor at most.
    const THRESHOLD = 0.2;
    let clusters = [
        ...pool.map(e => ({ ids: [e.path], anchor: null, members: [e] })),
        ...anchors.map(a => ({ ids: [`anchor:${a.path}`], anchor: a, members: [] })),
    ];
    const sim = new Map();
    const pairSim = (a, b) => {
        const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;
        if (!sim.has(key))
            sim.set(key, cosine(vectors.get(a), vectors.get(b)));
        return sim.get(key);
    };
    const linkage = (x, y) => {
        let total = 0;
        for (const a of x.ids)
            for (const b of y.ids)
                total += pairSim(a, b);
        return total / (x.ids.length * y.ids.length);
    };
    const label = (c) => [...c.ids].sort(byText).join('|');
    for (;;) {
        let best = null;
        for (let i = 0; i < clusters.length; i++) {
            for (let j = i + 1; j < clusters.length; j++) {
                const x = clusters[i];
                const y = clusters[j];
                if (x.anchor && y.anchor)
                    continue;
                if (x.members.length + y.members.length > context.maxFlatFiles)
                    continue;
                const s = linkage(x, y);
                if (s < THRESHOLD)
                    continue;
                const key = [label(x), label(y)].sort(byText).join('#');
                if (!best || s > best.s + 1e-9 || (Math.abs(s - best.s) <= 1e-9 && key < best.key))
                    best = { i, j, s, key };
            }
        }
        if (!best)
            break;
        const x = clusters[best.i];
        const y = clusters[best.j];
        clusters = clusters.filter((_, k) => k !== best.i && k !== best.j);
        clusters.push({ ids: [...x.ids, ...y.ids], anchor: x.anchor ?? y.anchor, members: [...x.members, ...y.members] });
    }
    clusters = clusters.filter(c => c.members.length)
        .map(c => ({ ...c, members: [...c.members].sort((a, b) => byText(a.path, b.path)) }))
        .sort((a, b) => Number(!!b.anchor) - Number(!!a.anchor) || b.members.length - a.members.length || byText(label(a), label(b)));
    // 5. Names.
    // The vocabulary of the project: names of its folders, segments of its routes, declared domains. A group is named by
    // what it does in that vocabulary, never after one of its files (`event-icon/`, `in-view/` say nothing of a feature).
    const vocabulary = new Set([
        ...[...context.dirs].map(d => posix.basename(d).toLowerCase()),
        ...context.files.flatMap(f => routeOf(f)?.route.split('/') ?? []).filter(seg => seg && !/^[([@+_.]/.test(seg)).map(seg => seg.toLowerCase()),
        ...context.domains,
    ].filter(w => !GENERIC.has(w)));
    const known = (name) => vocabulary.has(name) || [...vocabulary].some(v => related(v, name));
    const staying = new Set([...coreSet, ...(context.others ?? [])].map(e => kebab(e.tokens)));
    const candidatesOf = (members) => {
        const map = new Map();
        const give = (name, score, source, conventions, naming) => {
            const clean = name.toLowerCase();
            if (!clean || GENERIC.has(clean) || /^[([@+_.]/.test(clean) || own.some(o => related(o, clean)) || staying.has(clean))
                return;
            const c = map.get(clean);
            if (c) {
                c.score += score;
                if (c.score - score < score)
                    Object.assign(c, { source, conventions, naming });
            }
            else
                map.set(clean, { name: clean, score, source, conventions, naming });
        };
        // Words several files share, when the project already uses them for a folder, a route or a domain.
        const counts = new Map();
        for (const e of members)
            for (const w of new Set(words(e.tokens, own)))
                counts.set(w, (counts.get(w) ?? 0) + 1);
        for (const [w, c] of [...counts].sort((a, b) => byText(a[0], b[0]))) {
            if (c < 2)
                continue;
            // The words the files share after it too (`FirstVisit`, `FirstVisitHint`: first-visit), when that name is known.
            const lists = members.map(e => e.tokens.filter(t => !own.some(o => related(o, t)))).map(l => l.slice(l.indexOf(w))).filter(l => l[0] === w);
            let k = 1;
            while (lists.length >= 2 && lists.every(l => l.length > k && l[k] === lists[0][k]))
                k++;
            const long = lists.length >= 2 ? lists[0].slice(0, k).join('-') : w;
            const name = known(long) ? long : known(w) ? w : null;
            if (name)
                give(name, 0.8 * c, `mot commun à ${c} fichiers, « ${name} », déjà un nom du projet (dossier, route ou domaine)`, ['feature-folders'], 'word');
        }
        for (const d of context.domains) {
            const hits = members.filter(e => kebab(e.tokens).startsWith(d)).length;
            if (hits)
                give(d, 1.5 * hits, `domaine déclaré (structure.domains) « ${d} »`, ['feature-folders'], 'domain');
        }
        if (!sharedKind) {
            // The feature folder or the route that uses the group, when one of them accounts for half of its use.
            const where = new Map();
            let total = 0;
            for (const e of members)
                for (const c of external(e)) {
                    const ctx = consumerContext(c);
                    const k = ctx.route !== null ? `route:${ctx.leaf ?? ctx.route}` : `dir:${ctx.dir}`;
                    where.set(k, (where.get(k) ?? 0) + 1);
                    total++;
                }
            for (const [k, count] of [...where].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))) {
                // Half of the use at least, and two uses: one import is no feature.
                if (count / total < 0.5 || count < 2)
                    break;
                if (k.startsWith('route:'))
                    give(k.slice(6), 2 * count / total, `route /${k.slice(6)}, qui les utilise (${count} sur ${total})`, ['feature-folders'], 'place');
                else
                    give(posix.basename(k.slice(4)), 2 * count / total, `dossier ${k.slice(4)}/, qui les utilise (${count} sur ${total})`, ['feature-folders'], 'place');
            }
        }
        return [...map.values()].sort((a, b) => b.score - a.score || byText(a.name, b.name));
    };
    const groups = [];
    const unplaced = [];
    const unnamed = [];
    const reasonsOf = (members, source) => {
        const reasons = [`nom repris : ${source}`];
        const ctx = new Map();
        for (const e of members)
            for (const c of external(e)) {
                const x = consumerContext(c);
                const k = x.route !== null ? `route /${x.route}` : `${x.dir}/`;
                ctx.set(k, (ctx.get(k) ?? 0) + 1);
            }
        const top = [...ctx].sort((a, b) => b[1] - a[1] || byText(a[0], b[0])).slice(0, 3);
        if (top.length)
            reasons.push(`utilisés par ${top.map(([k, c]) => `${k} (${c})`).join(', ')}`);
        const links = [];
        for (const e of members)
            for (const x of internal(e))
                if (members.includes(x))
                    links.push(`${posix.basename(x.path)} importe ${posix.basename(e.path)}`);
        if (links.length)
            reasons.push(`liés par import : ${links.sort(byText).slice(0, 3).join(', ')}${links.length > 3 ? ', …' : ''}`);
        return reasons;
    };
    const taken = new Set();
    for (const c of clusters) {
        if (c.anchor) {
            const a = c.anchor;
            const linked = (e) => imp.get(e).some(p => a.files.includes(p)) || a.files.some(f => (graph.importers.get(f) ?? []).some(p => e.files.includes(p)));
            // Outside the folder, the same split needs an import between the file and the anchor, not only the same users.
            if (!a.existing) {
                unplaced.push(...c.members.filter(e => !linked(e)));
                c.members = c.members.filter(linked);
                if (!c.members.length)
                    continue;
            }
            const used = c.members.flatMap(e => imp.get(e).filter(p => a.files.includes(p))).length;
            // One file joins an anchor only when the anchor accounts for half of its use.
            if (c.members.length === 1) {
                const e = c.members[0];
                const uses = imp.get(e).length + a.files.filter(f => (graph.importers.get(f) ?? []).some(p => e.files.includes(p))).length;
                const withAnchor = imp.get(e).filter(p => a.files.includes(p)).length + a.files.filter(f => (graph.importers.get(f) ?? []).some(p => e.files.includes(p))).length;
                if (!uses || withAnchor / uses < 0.5) {
                    unplaced.push(e);
                    continue;
                }
            }
            const source = a.existing ? `sous-dossier existant ${a.path}/` : a.proposed ? `même découpage que le groupe ${a.path}/ proposé pour ${dirOf(a.path)}/` : `même découpage que ${a.path}/`;
            const reasons = reasonsOf(c.members, source);
            if (used)
                reasons.splice(1, 0, `importés par ${used} fichier(s) de ${a.path}/`);
            if (a.proposed)
                reasons.push('groupe à créer en même temps que celui du dossier miroir');
            const same = groups.find(g => g.dir === a.name);
            if (same) {
                same.members.push(...c.members.map(e => e.path));
                continue;
            }
            taken.add(a.name);
            groups.push({ dir: a.name, members: c.members.map(e => e.path), existing: a.existing, reasons, conventions: a.existing ? ['feature-folders'] : ['feature-folders', 'mirror'], naming: a.existing ? 'existing' : 'mirror' });
            continue;
        }
        if (c.members.length < 2) {
            unplaced.push(...c.members);
            continue;
        }
        let chosen = candidatesOf(c.members).find(x => !taken.has(x.name));
        // A name that is an existing subfolder of the folder (`scene` next to `scenes/`): the files join it.
        const existing = chosen ? anchors.find(a => a.existing && related(a.name, chosen.name)) : undefined;
        if (existing) {
            const same = groups.find(g => g.dir === existing.name);
            const reasons = reasonsOf(c.members, `sous-dossier existant ${existing.path}/ (${chosen.source})`);
            if (same) {
                same.members.push(...c.members.map(e => e.path));
                same.reasons.push(...reasons.slice(0, 1));
                continue;
            }
            taken.add(existing.name);
            groups.push({ dir: existing.name, members: c.members.map(e => e.path), existing: true, reasons, conventions: ['feature-folders'], naming: 'existing' });
            continue;
        }
        if (chosen && taken.has(chosen.name))
            chosen = undefined;
        // No name of the project says what the group does: grouped, but left to the operator to name (never invented).
        if (!chosen) {
            unnamed.push({ members: c.members.map(e => e.path).sort(byText), reasons: reasonsOf(c.members, 'aucun nom du projet (dossier, route, domaine) ne dit ce que fait ce groupe : à nommer par l\'opérateur').slice(1) });
            continue;
        }
        taken.add(chosen.name);
        groups.push({ dir: chosen.name, members: c.members.map(e => e.path), existing: false, reasons: reasonsOf(c.members, chosen.source), conventions: chosen.conventions, naming: chosen.naming });
    }
    // The root must end under the threshold: while it does not, the file closest to a group joins it (never above the
    // threshold, never a file that shares nothing with the group), and the group says so.
    const rootCount = () => (context.staying ?? 0) + core.length + unplaced.length + unnamed.reduce((n, u) => n + u.members.length, 0);
    while (rootCount() > context.maxFlatFiles && unplaced.length) {
        let best = null;
        for (const e of [...unplaced].sort((a, b) => byText(a.path, b.path))) {
            for (const g of [...groups, ...unnamed]) {
                if (g.members.length >= context.maxFlatFiles)
                    continue;
                const sims = g.members.map(m => (vectors.has(m) ? pairSim(e.path, m) : 0));
                const s = sims.reduce((a, b) => a + b, 0) / Math.max(1, sims.length);
                if (s > 0.05 && (!best || s > best.s + 1e-9))
                    best = { e, g, s };
            }
        }
        if (!best)
            break;
        best.g.members.push(best.e.path);
        best.g.reasons.push(`${posix.basename(best.e.path)} rattaché au groupe le plus proche (similarité ${best.s.toFixed(2).replace('.', ',')}) pour ramener la racine sous le seuil`);
        unplaced.splice(unplaced.indexOf(best.e), 1);
    }
    for (const g of [...groups, ...unnamed])
        g.members.sort(byText);
    return { core, groups, unnamed, unplaced: unplaced.map(e => e.path).sort(byText) };
}
/** The usage graph of a code map: who imports each component and module, and what the modules export. */
export function usageFromMap(map) {
    const importers = new Map();
    const exports = new Map();
    for (const c of map.components)
        importers.set(c.path, [...c.usedBy]);
    for (const m of map.modules) {
        importers.set(m.path, [...m.usedBy]);
        exports.set(m.path, m.exports.map(e => e.name));
    }
    return { importers, exports };
}
//# sourceMappingURL=split.js.map
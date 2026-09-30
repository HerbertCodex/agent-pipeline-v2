import { posix } from 'node:path';
import { routeOf } from '../knowledge/code-map.js';
import { parseName, related, tokenize } from './names.js';

/**
 * Split of a flat folder by proximity of use (docs/STRUCTURE.md, « Découpage d'un dossier à plat »). Deterministic and
 * explainable:
 * 1. the core of the folder (files a large part of it imports, or its model by convention) stays at its root;
 * 2. every other file is described by who uses it (the folders and routes of its importers), the files of the folder it
 *    is linked to by an import, and the words of its name and exports;
 * 3. the subfolders that already exist, in the folder or in a folder of the same domain elsewhere (`components/<domaine>/`
 *    for `lib/<domaine>/`), are described the same way and attract the files used like them (same split everywhere);
 * 4. files are grouped by similarity of those descriptions (weighted cosine, average linkage, most similar pair first);
 * 5. each group is named after the vocabulary the project already uses (existing or mirrored subfolder, its main module,
 *    a word its files share, the folder or route that uses it), and says why.
 * Nothing reads a file here: the import graph comes from the code map (src/knowledge/code-map.ts).
 */

/** Who imports whom, tests left out, and what each module exports. */
export interface UsageGraph {
  /** File -> files that import it. */
  importers: ReadonlyMap<string, readonly string[]>;
  /** File -> names it exports. */
  exports: ReadonlyMap<string, readonly string[]>;
}

/** A file of the folder with its companions and tests (they move with it). */
export interface SplitEntry { path: string; stem: string; files: readonly string[]; component: boolean; tokens: readonly string[] }

export interface SplitGroup {
  /** Subfolder name, relative to the folder. */
  dir: string;
  /** Main files, repository-relative. */
  members: string[];
  /** The subfolder already exists: the files join it. */
  existing: boolean;
  /** Why these files go together, in French, one sentence each. */
  reasons: string[];
  /** Conventions of the stack profile the group follows (ids of src/structure/profiles.ts). */
  conventions: string[];
  /** Where the name comes from: an existing subfolder, the same split elsewhere, the main module or component, a shared word, a declared domain, the folder or route that uses the group. */
  naming: 'existing' | 'mirror' | 'module' | 'component' | 'word' | 'domain' | 'place';
}

export interface SplitResult {
  /** Files that stay at the root of the folder: its core (imported by much of it) or its model by convention. */
  core: { path: string; reason: string }[];
  groups: SplitGroup[];
  /** Files no group takes: left to the operator. */
  unplaced: string[];
}

export interface SplitContext {
  /** Every directory of the project (the vocabulary of existing folders). */
  dirs: ReadonlySet<string>;
  /** Every code file of the project: the existing subfolders are described by their files. */
  files: readonly string[];
  domains: readonly string[];
  maxFlatFiles: number;
  /** Entries of the folder that are not split (reserved, already placed by another rule): they count for the core. */
  others?: readonly SplitEntry[];
  /** Entries of the folder outside the split that stay at its root (entry points): they count against the threshold. */
  staying?: number;
  /** Groups already proposed for other flat folders (folder -> groups): a folder of the same domain follows the same split. */
  proposed?: ReadonlyMap<string, readonly { dir: string; members: readonly string[] }[]>;
}

/** Folder names that say nothing of a feature: never a group name. */
const GENERIC = new Set(['src', 'lib', 'app', 'apps', 'components', 'component', 'ui', 'shared', 'common', 'utils', 'util', 'helpers', 'server', 'client',
  'routes', 'pages', 'core', 'base', 'misc', 'internal', 'pkg', 'modules', 'features', 'tests', 'test', 'index', 'main', 'types', 'api', 'svelte', 'ts']);
/** Folders of shared building blocks: their files are used everywhere, a group is named by what the files are, never by who uses them. */
const SHARED_KIND = new Set(['ui', 'shared', 'common', 'components', 'primitives', 'utils', 'util', 'helpers', 'lib', 'design-system', 'elements', 'atoms']);
/** Module names that are the model of a domain by convention: they stay at its root. */
const MODEL_NAMES = new Set(['model', 'models', 'types', 'type', 'schema', 'schemas', 'constants', 'domain', 'entities']);
/** Words that never name a group: too common in names. */
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'get', 'set', 'is', 'has', 'to', 'of', 'in', 'on', 'a', 'an', 'new', 'use', 'make', 'create', 'build', 'default', 'type', 'types', 'props', 'data', 'value', 'values', 'item', 'items']);

const dirOf = (path: string): string => posix.dirname(path);
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const kebab = (tokens: readonly string[]): string => tokens.join('-');

type Vector = Map<string, number>;

function cosine(a: Vector, b: Vector): number {
  let dot = 0; let na = 0; let nb = 0;
  for (const [k, v] of a) { na += v * v; const w = b.get(k); if (w !== undefined) dot += v * w; }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** What a consumer file says of its use: the route it serves (first two segments), or its folder. */
function consumerContext(path: string): { key: string; route: string | null; dir: string } {
  const route = routeOf(path);
  if (route) {
    const segments = route.route.split('/').filter(Boolean);
    return { key: `route:/${segments.slice(0, 2).join('/')}`, route: segments[0] ?? '', dir: dirOf(path) };
  }
  return { key: `dir:${dirOf(path)}`, route: null, dir: dirOf(path) };
}

/** Words of a name, short, stop and folder words left out. */
function words(tokens: readonly string[], own: readonly string[]): string[] {
  return tokens.filter(t => t.length > 2 && !STOP.has(t) && !own.some(o => related(o, t)));
}

/** A subfolder that attracts files: in the folder itself (`existing`) or in a folder of the same domain elsewhere. */
interface Anchor { name: string; path: string; existing: boolean; files: string[]; proposed: boolean }

/**
 * Proposes subfolders for the entries of `folder`. Pure and deterministic: the same entries and graph give the same
 * groups, in the same order, with the same names.
 */
export function proposeSplit(folder: string, entries: readonly SplitEntry[], graph: UsageGraph, context: SplitContext): SplitResult {
  const base = posix.basename(folder);
  const own = tokenize(base);
  const sharedKind = SHARED_KIND.has(base.toLowerCase());
  const all = [...entries, ...(context.others ?? [])];
  const entryOfFile = new Map<string, SplitEntry>();
  for (const e of all) for (const f of e.files) entryOfFile.set(f, e);
  const isTest = (path: string): boolean => parseName(path)?.test ?? false;
  const importersOfFiles = (files: readonly string[]): string[] => [...new Set(files.flatMap(f => graph.importers.get(f) ?? []))]
    .filter(p => !files.includes(p) && !isTest(p)).sort(byText);
  const imp = new Map(all.map(e => [e, importersOfFiles(e.files)]));
  const internalMemo = new Map<SplitEntry, SplitEntry[]>();
  const internal = (e: SplitEntry): SplitEntry[] => {
    if (!internalMemo.has(e)) internalMemo.set(e, [...new Set(imp.get(e)!.map(p => entryOfFile.get(p)).filter((x): x is SplitEntry => !!x && x !== e))]);
    return internalMemo.get(e)!;
  };
  const external = (e: SplitEntry): string[] => imp.get(e)!.filter(p => !entryOfFile.has(p));

  // 1. Core.
  const coreMin = Math.max(3, Math.ceil(all.length / 5));
  const core: SplitResult['core'] = [];
  const coreSet = new Set<SplitEntry>();
  for (const e of entries) {
    const users = internal(e);
    const shown = `${users.slice(0, 3).map(u => posix.basename(u.path)).join(', ')}${users.length > 3 ? ', …' : ''}`;
    if (users.length >= coreMin) {
      coreSet.add(e);
      core.push({ path: e.path, reason: `importé par ${users.length} fichiers du dossier (${shown}) : socle du domaine, reste à sa racine` });
    } else if (!e.component && users.length && MODEL_NAMES.has(e.stem.toLowerCase())) {
      coreSet.add(e);
      core.push({ path: e.path, reason: `modèle du domaine par son nom, importé par ${shown} : reste à sa racine` });
    }
  }
  const pool = entries.filter(e => !coreSet.has(e));

  // 3. Anchors: existing subfolders, and the subfolders of the folders of the same domain elsewhere.
  const anchors: Anchor[] = [];
  const childrenOf = (dir: string): string[] => [...context.dirs].filter(d => dirOf(d) === dir).sort(byText);
  // Route folders are URL segments, never a code split to copy; generic names (`components`, `ui`) are no feature.
  const routeRoots = [...new Set(context.files.map(f => routeOf(f)?.root).filter((r): r is string => !!r))];
  const inRoutes = (d: string): boolean => routeRoots.some(r => d === r || d.startsWith(`${r}/`));
  const usable = (d: string): boolean => !inRoutes(d) && !GENERIC.has(posix.basename(d).toLowerCase()) && !/^[([@+_.]/.test(posix.basename(d));
  for (const d of childrenOf(folder)) if (usable(d)) anchors.push({ name: posix.basename(d), path: d, existing: true, files: [], proposed: false });
  const mirrors = [...context.dirs].filter(d => d !== folder && posix.basename(d) === base && !inRoutes(d) && !d.startsWith(`${folder}/`) && !folder.startsWith(`${d}/`)).sort(byText);
  if (!sharedKind) {
    for (const m of mirrors) {
      for (const d of childrenOf(m)) if (usable(d) && !anchors.some(a => a.name === posix.basename(d))) anchors.push({ name: posix.basename(d), path: d, existing: false, files: [], proposed: false });
      for (const g of context.proposed?.get(m) ?? []) {
        if (anchors.some(a => a.name === g.dir)) continue;
        anchors.push({ name: g.dir, path: `${m}/${g.dir}`, existing: false, files: [...g.members], proposed: true });
      }
    }
  }
  for (const a of anchors) if (!a.proposed) a.files = context.files.filter(f => f.startsWith(`${a.path}/`) && !isTest(f));

  // 2. Features.
  const add = (v: Vector, key: string, w: number): void => { v.set(key, (v.get(key) ?? 0) + w); };
  const raw = new Map<string, Vector>();
  const describe = (id: string, files: readonly string[], users: readonly string[], tokens: readonly string[], links: readonly string[]): void => {
    const v: Vector = new Map();
    for (const c of users) {
      if (entryOfFile.has(c)) continue;
      const ctx = consumerContext(c);
      add(v, ctx.key, 1);
      // Imported together by the same file.
      add(v, `by:${c}`, 0.5);
    }
    for (const l of links) add(v, `link:${l}`, 2);
    if (links.length) add(v, `link:${id}`, 2);
    for (const w of words(tokens, own)) add(v, `word:${w}`, 1);
    const exported = new Set(files.flatMap(f => graph.exports.get(f) ?? []).flatMap(n => words(tokenize(n), own)).filter(w => w.length > 3));
    for (const w of exported) add(v, `word:${w}`, 0.4);
    raw.set(id, v);
  };
  const linksOf = new Map<SplitEntry, SplitEntry[]>();
  for (const e of pool) {
    const links = pool.filter(x => x !== e && (internal(e).includes(x) || internal(x).includes(e)));
    linksOf.set(e, links);
    describe(e.path, e.files, imp.get(e)!, e.tokens, links.map(x => x.path));
  }
  for (const a of anchors) {
    // An anchor is used where its files are used, and from its own folder (`dir:<anchor>`: its files import the entry).
    const users = [...importersOfFiles(a.files).filter(p => !a.files.includes(p)), ...a.files];
    describe(`anchor:${a.path}`, a.files, users, tokenize(a.name), []);
    // The files of the anchor that import an entry of the pool: a link, as between two entries.
    const v = raw.get(`anchor:${a.path}`)!;
    for (const e of pool) {
      // Both ways: files of the anchor import the entry, or the entry imports files of the anchor.
      const n = imp.get(e)!.filter(p => a.files.includes(p)).length + a.files.filter(f => (graph.importers.get(f) ?? []).some(p => e.files.includes(p))).length;
      if (n) { add(v, `link:${e.path}`, 2); const ev = raw.get(e.path)!; add(ev, `link:anchor:${a.path}`, 2); if (!ev.has(`link:${e.path}`)) add(ev, `link:${e.path}`, 2); add(v, `link:anchor:${a.path}`, 2); }
    }
  }
  const df = new Map<string, number>();
  for (const v of raw.values()) for (const k of v.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const n = Math.max(1, raw.size);
  const vectors = new Map<string, Vector>();
  for (const [id, v] of raw) {
    const out: Vector = new Map();
    for (const [k, w] of v) if (w > 0) out.set(k, (1 + Math.log(w)) * Math.max(0.05, Math.log(1 + n / df.get(k)!)));
    vectors.set(id, out);
  }

  // 4. Average linkage, the most similar pair first; ties broken by the names. A cluster holds one anchor at most.
  const THRESHOLD = 0.2;
  interface Cluster { ids: string[]; anchor: Anchor | null; members: SplitEntry[] }
  let clusters: Cluster[] = [
    ...pool.map(e => ({ ids: [e.path], anchor: null, members: [e] })),
    ...anchors.map(a => ({ ids: [`anchor:${a.path}`], anchor: a, members: [] as SplitEntry[] })),
  ];
  const sim = new Map<string, number>();
  const pairSim = (a: string, b: string): number => {
    const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;
    if (!sim.has(key)) sim.set(key, cosine(vectors.get(a)!, vectors.get(b)!));
    return sim.get(key)!;
  };
  const linkage = (x: Cluster, y: Cluster): number => {
    let total = 0;
    for (const a of x.ids) for (const b of y.ids) total += pairSim(a, b);
    return total / (x.ids.length * y.ids.length);
  };
  const label = (c: Cluster): string => [...c.ids].sort(byText).join('|');
  for (;;) {
    let best: { i: number; j: number; s: number; key: string } | null = null;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const x = clusters[i]!; const y = clusters[j]!;
        if (x.anchor && y.anchor) continue;
        if (x.members.length + y.members.length > context.maxFlatFiles) continue;
        const s = linkage(x, y);
        if (s < THRESHOLD) continue;
        const key = [label(x), label(y)].sort(byText).join('#');
        if (!best || s > best.s + 1e-9 || (Math.abs(s - best.s) <= 1e-9 && key < best.key)) best = { i, j, s, key };
      }
    }
    if (!best) break;
    const x = clusters[best.i]!; const y = clusters[best.j]!;
    clusters = clusters.filter((_, k) => k !== best!.i && k !== best!.j);
    clusters.push({ ids: [...x.ids, ...y.ids], anchor: x.anchor ?? y.anchor, members: [...x.members, ...y.members] });
  }
  clusters = clusters.filter(c => c.members.length)
    .map(c => ({ ...c, members: [...c.members].sort((a, b) => byText(a.path, b.path)) }))
    .sort((a, b) => Number(!!b.anchor) - Number(!!a.anchor) || b.members.length - a.members.length || byText(label(a), label(b)));

  // 5. Names.
  const vocabulary = new Set([...context.dirs].map(d => posix.basename(d).toLowerCase()));
  const staying = new Set([...coreSet, ...(context.others ?? [])].map(e => kebab(e.tokens)));
  interface Candidate { name: string; score: number; source: string; conventions: string[]; naming: SplitGroup['naming'] }
  const candidatesOf = (members: SplitEntry[]): Candidate[] => {
    const map = new Map<string, Candidate>();
    const give = (name: string, score: number, source: string, conventions: string[], naming: SplitGroup['naming']): void => {
      const clean = name.toLowerCase();
      if (!clean || GENERIC.has(clean) || /^[([@+_.]/.test(clean) || own.some(o => related(o, clean)) || staying.has(clean)) return;
      const c = map.get(clean);
      if (c) { c.score += score; if (c.score - score < score) Object.assign(c, { source, conventions, naming }); }
      else map.set(clean, { name: clean, score, source, conventions, naming });
    };
    // The main module of the group: the one the others import most, else the most used.
    const degree = (x: SplitEntry): number => members.filter(m => m !== x && (internal(x).includes(m) || internal(m).includes(x))).length;
    // Equal degree: the one that imports the others (`invoice` imports `tax`), then the most used.
    const uses = (x: SplitEntry): number => members.filter(m => m !== x && internal(m).includes(x)).length;
    const main = [...members].sort((a, b) => degree(b) - degree(a) || uses(b) - uses(a) || imp.get(b)!.length - imp.get(a)!.length || byText(a.path, b.path))[0]!;
    if (!main.component || members.length > 1) give(kebab(main.tokens), 1.5, `${main.component ? 'composant' : 'module'} principal du groupe, ${posix.basename(main.path)}`, ['feature-folders'], main.component ? 'component' : 'module');
    const counts = new Map<string, number>();
    for (const e of members) for (const w of new Set(words(e.tokens, own))) counts.set(w, (counts.get(w) ?? 0) + 1);
    for (const [w, c] of [...counts].sort((a, b) => byText(a[0], b[0]))) {
      if (c < 2) continue;
      // The words the files share after it too (`FirstVisit`, `FirstVisitHint`: first-visit).
      const lists = members.map(e => e.tokens.filter(t => !own.some(o => related(o, t)))).map(l => l.slice(l.indexOf(w))).filter(l => l[0] === w);
      let k = 1;
      while (lists.length >= 2 && lists.every(l => l.length > k && l[k] === lists[0]![k])) k++;
      const name = lists.length >= 2 ? lists[0]!.slice(0, k).join('-') : w;
      give(name, 0.8 * c, `mot commun à ${c} fichiers, « ${name} »`, ['feature-folders'], 'word');
    }
    for (const d of context.domains) {
      const hits = members.filter(e => kebab(e.tokens).startsWith(d)).length;
      if (hits) give(d, hits, `domaine déclaré (structure.domains) « ${d} »`, ['feature-folders'], 'domain');
    }
    if (!sharedKind) {
      // The folder or the route that uses the group, when one of them accounts for most of its use.
      const where = new Map<string, number>();
      let total = 0;
      for (const e of members) for (const c of external(e)) {
        const ctx = consumerContext(c);
        const k = ctx.route !== null ? `route:${ctx.route}` : `dir:${ctx.dir}`;
        where.set(k, (where.get(k) ?? 0) + 1); total++;
      }
      for (const [k, count] of [...where].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))) {
        if (count / total < 0.6) break;
        if (k.startsWith('route:')) give(k.slice(6), 1.2, `route /${k.slice(6)}, qui les utilise`, ['feature-folders'], 'place');
        else if (vocabulary.has(posix.basename(k.slice(4)).toLowerCase())) give(posix.basename(k.slice(4)), 1.2, `dossier ${k.slice(4)}/, qui les utilise`, ['feature-folders'], 'place');
      }
    }
    return [...map.values()].sort((a, b) => b.score - a.score || byText(a.name, b.name));
  };

  const groups: SplitGroup[] = [];
  const unplaced: SplitEntry[] = [];
  const reasonsOf = (members: SplitEntry[], source: string): string[] => {
    const reasons = [`nom repris : ${source}`];
    const ctx = new Map<string, number>();
    for (const e of members) for (const c of external(e)) { const x = consumerContext(c); const k = x.route !== null ? `route /${x.route}` : `${x.dir}/`; ctx.set(k, (ctx.get(k) ?? 0) + 1); }
    const top = [...ctx].sort((a, b) => b[1] - a[1] || byText(a[0], b[0])).slice(0, 3);
    if (top.length) reasons.push(`utilisés par ${top.map(([k, c]) => `${k} (${c})`).join(', ')}`);
    const links: string[] = [];
    for (const e of members) for (const x of internal(e)) if (members.includes(x)) links.push(`${posix.basename(x.path)} importe ${posix.basename(e.path)}`);
    if (links.length) reasons.push(`liés par import : ${links.sort(byText).slice(0, 3).join(', ')}${links.length > 3 ? ', …' : ''}`);
    return reasons;
  };
  const taken = new Set<string>();
  for (const c of clusters) {
    if (c.anchor) {
      const a = c.anchor;
      const linked = (e: SplitEntry): boolean => imp.get(e)!.some(p => a.files.includes(p)) || a.files.some(f => (graph.importers.get(f) ?? []).some(p => e.files.includes(p)));
      // Outside the folder, the same split needs an import between the file and the anchor, not only the same users.
      if (!a.existing) {
        unplaced.push(...c.members.filter(e => !linked(e)));
        c.members = c.members.filter(linked);
        if (!c.members.length) continue;
      }
      const used = c.members.flatMap(e => imp.get(e)!.filter(p => a.files.includes(p))).length;
      // One file joins an anchor only when the anchor accounts for half of its use.
      if (c.members.length === 1) {
        const e = c.members[0]!;
        const uses = imp.get(e)!.length + a.files.filter(f => (graph.importers.get(f) ?? []).some(p => e.files.includes(p))).length;
        const withAnchor = imp.get(e)!.filter(p => a.files.includes(p)).length + a.files.filter(f => (graph.importers.get(f) ?? []).some(p => e.files.includes(p))).length;
        if (!uses || withAnchor / uses < 0.5) { unplaced.push(e); continue; }
      }
      const source = a.existing ? `sous-dossier existant ${a.path}/` : a.proposed ? `même découpage que le groupe ${a.path}/ proposé pour ${dirOf(a.path)}/` : `même découpage que ${a.path}/`;
      const reasons = reasonsOf(c.members, source);
      if (used) reasons.splice(1, 0, `importés par ${used} fichier(s) de ${a.path}/`);
      if (a.proposed) reasons.push('groupe à créer en même temps que celui du dossier miroir');
      const same = groups.find(g => g.dir === a.name);
      if (same) { same.members.push(...c.members.map(e => e.path)); continue; }
      taken.add(a.name);
      groups.push({ dir: a.name, members: c.members.map(e => e.path), existing: a.existing, reasons, conventions: a.existing ? ['feature-folders'] : ['feature-folders', 'mirror'], naming: a.existing ? 'existing' : 'mirror' });
      continue;
    }
    if (c.members.length < 2) { unplaced.push(...c.members); continue; }
    const chosen = candidatesOf(c.members).find(x => !taken.has(x.name) && !anchors.some(a => a.existing && a.name === x.name));
    if (!chosen) { unplaced.push(...c.members); continue; }
    taken.add(chosen.name);
    groups.push({ dir: chosen.name, members: c.members.map(e => e.path), existing: false, reasons: reasonsOf(c.members, chosen.source), conventions: chosen.conventions, naming: chosen.naming });
  }
  // The root must end under the threshold: while it does not, the file closest to a group joins it (never above the
  // threshold, never a file that shares nothing with the group), and the group says so.
  const rootCount = (): number => (context.staying ?? 0) + core.length + unplaced.length;
  while (rootCount() > context.maxFlatFiles && unplaced.length) {
    let best: { e: SplitEntry; g: SplitGroup; s: number } | null = null;
    for (const e of [...unplaced].sort((a, b) => byText(a.path, b.path))) {
      for (const g of groups) {
        if (g.members.length >= context.maxFlatFiles) continue;
        const sims = g.members.map(m => (vectors.has(m) ? pairSim(e.path, m) : 0));
        const s = sims.reduce((a, b) => a + b, 0) / Math.max(1, sims.length);
        if (s > 0.05 && (!best || s > best.s + 1e-9)) best = { e, g, s };
      }
    }
    if (!best) break;
    best.g.members.push(best.e.path);
    best.g.reasons.push(`${posix.basename(best.e.path)} rattaché au groupe le plus proche (similarité ${best.s.toFixed(2).replace('.', ',')}) pour ramener la racine sous le seuil`);
    unplaced.splice(unplaced.indexOf(best.e), 1);
  }
  for (const g of groups) g.members.sort(byText);
  return { core, groups, unplaced: unplaced.map(e => e.path).sort(byText) };
}

/** The usage graph of a code map: who imports each component and module, and what the modules export. */
export function usageFromMap(map: { components: readonly { path: string; usedBy: readonly string[] }[]; modules: readonly { path: string; usedBy: readonly string[]; exports: readonly { name: string }[] }[] }): UsageGraph {
  const importers = new Map<string, string[]>();
  const exports = new Map<string, string[]>();
  for (const c of map.components) importers.set(c.path, [...c.usedBy]);
  for (const m of map.modules) { importers.set(m.path, [...m.usedBy]); exports.set(m.path, m.exports.map(e => e.name)); }
  return { importers, exports };
}

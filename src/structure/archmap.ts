import { posix } from 'node:path';
import { routeOf } from '../knowledge/code-map.js';
import { PipelineError } from '../domain/errors.js';
import { ignoreTest, type StructureSettings } from './config.js';
import { parseName } from './names.js';
import { COMMON_KNOWN, conventionOf, knownPath, segmentGlob, type KnownPath, type StackProfile } from './profiles.js';

/**
 * The architecture map (docs/STRUCTURE.md, « Carte de l'architecture »): one short page that a developer or an agent
 * reads first. Generated parts (the tree, the entry points, the links) are rewritten by `apv map` and
 * `apv structure map`; written parts (summary, layers and flows, cross-cutting rules, roles) sit between markers and are
 * never rewritten. `apv structure check --base` refuses a folder of the first or second level, a main route or an entry
 * point the change adds without a role in the written part, and a link the change breaks.
 */

export type ItemKind = 'folder' | 'route' | 'entry';
/** Something the map must describe: a folder (`src/lib/applications/`), a main route (`/agenda`), an entry point (a file). */
export interface ArchItem { kind: ItemKind; key: string; known: KnownPath | null }

export const GENERATED_BLOCKS = ['arborescence', 'entrees', 'liens'] as const;
export const WRITTEN_BLOCKS = ['resume', 'flux', 'regles', 'roles'] as const;
type BlockId = typeof GENERATED_BLOCKS[number] | typeof WRITTEN_BLOCKS[number];
const kindOf = (id: BlockId): 'genere' | 'ecrit' => ((GENERATED_BLOCKS as readonly string[]).includes(id) ? 'genere' : 'ecrit');
const open = (id: BlockId): string => `<!-- apv:${kindOf(id)}:${id} -->`;
const close = (id: BlockId): string => `<!-- /apv:${kindOf(id)}:${id} -->`;
const HEADINGS: Record<BlockId, string> = {
  resume: 'En bref', flux: 'Couches et flux', arborescence: 'Arborescence', entrees: 'Points d\'entrée',
  regles: 'Règles transverses', liens: 'Pour aller plus loin', roles: 'Rôles (source des descriptions)',
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const PLACEHOLDER = /^(?:à décrire|a decrire|todo|tbd|\?+|…|\.\.\.)?[.\s]*$/i;

/** A role says something: three words at least, placeholders apart (`x`, `divers`, « à décrire » are no role). */
export const MIN_ROLE_WORDS = 3;
export function meaningfulRole(role: string): boolean {
  return !PLACEHOLDER.test(role) && role.trim().split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length >= MIN_ROLE_WORDS;
}

/** Markers present more than once: a copied block would make a stale map look up to date. */
export function duplicateMarkers(text: string): string[] {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/<!--\s*\/?apv:(?:ecrit|genere):[a-z]+\s*-->/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  return [...counts].filter(([, n]) => n > 1).map(([m]) => m).sort();
}

/** Content of a block, or null when the file does not have it. */
export function blockOf(text: string, id: BlockId): string | null {
  const start = text.indexOf(open(id));
  const end = text.indexOf(close(id));
  if (start < 0 || end < start) return null;
  return text.slice(start + open(id).length, end).replace(/^\n/, '').replace(/\n$/, '');
}

/** The map without the content of its `roles` block: what a task must leave as it is. */
export function withoutRoles(text: string): string {
  const start = text.indexOf(open('roles'));
  const end = text.indexOf(close('roles'));
  return start < 0 || end < start ? text : `${text.slice(0, start)}${text.slice(end)}`;
}

/** The roles written in the `roles` block: key (a path, `/route`, a glob with `*`) -> role, placeholders left out. */
export function writtenRoles(text: string | null): Map<string, string> {
  const out = new Map<string, string>();
  const block = text === null ? null : blockOf(text, 'roles');
  if (block === null) return out;
  for (const line of block.split('\n')) {
    const m = /^\s*[-*]\s+`([^`]+)`\s*:?\s*(.*)$/.exec(line);
    if (!m) continue;
    const role = m[2]!.trim();
    if (meaningfulRole(role)) out.set(m[1]!.trim(), role);
  }
  return out;
}

/**
 * The written role of an item: its exact key, else a glob of the roles block (`src/lib/*` or `src/lib/*\/`). With `globs`,
 * only those globs count (for an item the change adds: the globs already at the base, never a catch-all it brings).
 */
export function roleOf(item: ArchItem, roles: ReadonlyMap<string, string>, globs?: ReadonlySet<string>): string | null {
  const bare = item.key.replace(/\/$/, '');
  for (const key of [item.key, bare, `${bare}/`]) if (roles.has(key)) return roles.get(key)!;
  for (const [key, role] of [...roles].sort((a, b) => byText(a[0], b[0]))) {
    if (!key.includes('*') || (globs && !globs.has(key))) continue;
    if (segmentGlob(key.replace(/\/$/, '')).test(bare)) return role;
  }
  return null;
}

const COMMON_ENTRIES: KnownPath[] = [
  { path: 'vercel.json', role: 'tâches planifiées de Vercel (crons)', convention: 'common' },
  { path: '.github/workflows/*', role: 'tâche planifiée de la CI (schedule)', convention: 'common' },
];

/**
 * What the map must describe, from the file list: folders of levels 1 and 2 (from the root and from the anchors of the
 * profile, route folders apart), main routes (first segment), entry points (the profile's, crons, migrations).
 * `read` gives a file's text (crons, scheduled workflows); null when unreadable.
 */
export function archItems(files: readonly string[], profile: StackProfile, settings: Pick<StructureSettings, 'ignore'>, read: (path: string) => string | null, always: ReadonlySet<string> = new Set()): ArchItem[] {
  const ignored = ignoreTest(settings, files, always);
  const kept = files.filter(f => !ignored(f));
  const dirs = new Set<string>();
  for (const f of kept) for (let d = posix.dirname(f); d !== '.'; d = posix.dirname(d)) dirs.add(d);
  const routeRoots = new Set([...profile.routeRoots.filter(r => dirs.has(r)), ...kept.map(f => routeOf(f)?.root).filter((r): r is string => !!r)]);
  const inRoutes = (d: string): boolean => [...routeRoots].some(r => d.startsWith(`${r}/`));
  const depth = (d: string): number => d.split('/').length;
  const items = new Map<string, ArchItem>();
  const folder = (d: string): void => {
    if (inRoutes(d) || items.has(`${d}/`)) return;
    items.set(`${d}/`, { kind: 'folder', key: `${d}/`, known: knownPath(profile, d) });
  };
  for (const d of [...dirs].sort(byText)) {
    if (depth(d) <= 2) folder(d);
    for (const anchor of profile.anchors) if (d.startsWith(`${anchor}/`) && depth(d) - depth(anchor) <= 2) folder(d);
  }
  // Main routes: the first segment of every route (groups and parameters kept as written).
  for (const f of kept) {
    const r = routeOf(f);
    if (!r) continue;
    const first = r.route.split('/').filter(Boolean)[0];
    const key = first ? `/${first}` : '/';
    if (!items.has(key)) items.set(key, { kind: 'route', key, known: null });
  }
  // Entry points: files the framework calls by name, crons, scheduled workflows, migration folders.
  const entryList = [...profile.entries, ...COMMON_ENTRIES];
  for (const f of files) {
    if (parseName(f)?.test) continue;
    const known = entryList.find(e => segmentGlob(e.path).test(f));
    if (!known) continue;
    if (f === 'vercel.json' && !/"crons"\s*:/.test(read(f) ?? '')) continue;
    if (f.startsWith('.github/workflows/') && !/^\s*schedule\s*:/m.test(read(f) ?? '')) continue;
    items.set(f, { kind: 'entry', key: f, known });
  }
  // A route named `cron` (`/api/cron/tick`): a scheduled task called from outside.
  for (const f of kept) {
    const r = routeOf(f);
    if (r && r.route.split('/').some(seg => /^crons?$/i.test(seg)) && !parseName(f)?.test) items.set(f, { kind: 'entry', key: f, known: { path: f, role: `tâche planifiée : ${r.route}, appelée par un déclencheur externe`, convention: 'common' } });
  }
  for (const d of dirs) {
    if (/(?:^|\/)migrations$/.test(d) && !inRoutes(d)) items.set(`${d}/`, { kind: 'entry', key: `${d}/`, known: knownPath(profile, d) ?? { path: d, role: 'migrations de la base, appliquées dans l\'ordre', convention: 'common' } });
  }
  return [...items.values()].sort((a, b) => byText(a.key, b.key));
}

/** A relative Markdown link of the map, broken when its target is neither a file nor a folder of the repository. */
export function brokenLinks(text: string, mapPath: string, exists: (path: string) => boolean): { target: string; line: number }[] {
  const out: { target: string; line: number }[] = [];
  const lines = text.split('\n');
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return;
    for (const m of line.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = m[1]!;
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
      const clean = decodeURIComponent(target.replace(/[#?].*$/, ''));
      if (!clean) continue;
      const resolved = posix.normalize(clean.startsWith('/') ? clean.slice(1) : posix.join(posix.dirname(mapPath), clean)).replace(/\/$/, '');
      if (resolved.startsWith('..') || !exists(resolved)) out.push({ target, line: index + 1 });
    }
  });
  return out;
}

export interface MapInputs {
  mapPath: string;
  profile: StackProfile;
  items: ArchItem[];
  /** Files of the repository (links to what exists). */
  files: readonly string[];
  /** Validated mockups folder, when declared. */
  designDir: string | null;
  codeMapPath: string;
  maxFlatFiles: number;
  /** Folders above the threshold, with their proposed subfolders. */
  crowded: { folder: string; code: number; groups: string[] }[];
  /** Dependencies of the project (for the draft of the layers). */
  dependencies: readonly string[];
  read: (path: string) => string | null;
}

/** A relative link from the map to a path, parentheses and spaces encoded (`(app)` would end a Markdown link). */
const link = (from: string, to: string): string => (posix.relative(posix.dirname(from), to) || '.').replace(/[() ]/g, c => encodeURIComponent(c).replace('(', '%28').replace(')', '%29'));

function conventionText(profile: StackProfile, known: KnownPath | null): string {
  if (!known) return '';
  const c = conventionOf(profile, known.convention);
  if (!c || !c.url) return '';
  return ` Convention : ${c.label} ([documentation](${c.url})).`;
}

/** Role shown for an item: the written one, else the known role of the stack, else a request to describe it. */
function shownRole(item: ArchItem, roles: ReadonlyMap<string, string>): string {
  const role = roleOf(item, roles) ?? (item.known ? `${item.known.role} (rôle connu de la pile, à confirmer dans « Rôles »)` : '**à décrire** dans « Rôles »');
  return role.replace(/[.\s]+$/, '');
}

/** The generated blocks, from the inputs and the written roles of the current file. */
export function generatedBlocks(inputs: MapInputs, roles: ReadonlyMap<string, string>): Record<typeof GENERATED_BLOCKS[number], string> {
  const { profile } = inputs;
  const feature = conventionOf(profile, 'feature-folders');
  const crowded = new Map(inputs.crowded.map(c => [`${c.folder}/`, c]));
  const tree = inputs.items.filter(i => i.kind === 'folder').map(item => {
    const known = item.known ?? (profile.anchors.some(a => item.key.startsWith(`${a}/`)) && feature ? { path: item.key, role: '', convention: 'feature-folders' } : null);
    const full = crowded.get(item.key);
    const flat = full ? ` Dossier à plat (${full.code} fichiers de code, seuil ${inputs.maxFlatFiles}) : ne pas y ajouter de fichier${full.groups.length ? ` ; sous-dossiers proposés : ${full.groups.join(', ')}` : ''}.` : '';
    const depth = item.key.split('/').length - 2;
    return `${'  '.repeat(Math.min(depth, 4))}- \`${item.key}\` : ${shownRole(item, roles)}.${conventionText(profile, known)}${flat}`;
  });
  const extra = inputs.crowded.filter(c => !inputs.items.some(i => i.key === `${c.folder}/`));
  if (extra.length) {
    tree.push('', 'Autres dossiers à plat (au-delà du deuxième niveau) :');
    for (const c of extra) tree.push(`- \`${c.folder}/\` : ${c.code} fichiers de code (seuil ${inputs.maxFlatFiles}) : ne pas y ajouter de fichier${c.groups.length ? ` ; sous-dossiers proposés : ${c.groups.join(', ')}` : ''}.`);
  }
  const entries: string[] = [];
  const routes = inputs.items.filter(i => i.kind === 'route');
  const entryItems = inputs.items.filter(i => i.kind === 'entry');
  if (entryItems.length) {
    entries.push('Fichiers et dossiers appelés par le cadre ou la plateforme :', '');
    for (const e of entryItems) entries.push(`- [\`${e.key}\`](${link(inputs.mapPath, e.key.replace(/\/$/, ''))}) : ${shownRole(e, roles)}.`);
  }
  if (routes.length) {
    if (entries.length) entries.push('');
    entries.push('Routes principales (premier segment de l\'URL) :', '');
    for (const r of routes) entries.push(`- \`${r.key}\` : ${shownRole(r, roles)}.`);
  }
  if (!entries.length) entries.push('Aucun point d\'entrée reconnu.');
  const present = new Set(inputs.files);
  const dirPresent = (d: string): boolean => inputs.files.some(f => f.startsWith(`${d}/`));
  const links: string[] = [];
  const addLink = (label: string, path: string, isDir = false, always = false): void => {
    if (always || (isDir ? dirPresent(path) : present.has(path))) links.push(`- [${label}](${link(inputs.mapPath, path)})`);
  };
  addLink('README du projet', 'README.md');
  addLink('Architecture détaillée', 'docs/architecture.md');
  // Written by `apv map` with this map: always linked.
  addLink(`Carte du code (composants, modules, routes) : ${inputs.codeMapPath}`, inputs.codeMapPath, false, true);
  addLink('Consigne commune des implementers : .apv/brief.md', '.apv/brief.md');
  addLink('Registre des décisions', '.apv/DECISIONS.md');
  addLink('Specs', '.apv/specs', true);
  if (inputs.designDir) addLink(`Maquettes validées : ${inputs.designDir}/`, inputs.designDir, true);
  for (const doc of inputs.files.filter(f => /^docs\/[^/]+\.md$/.test(f) && f !== 'docs/architecture.md' && f !== inputs.mapPath).sort(byText).slice(0, 15)) {
    addLink(posix.basename(doc), doc);
  }
  const urls = new Set<string>();
  for (const c of profile.conventions.filter(x => x.url)) {
    if (urls.has(c.url)) continue;
    urls.add(c.url);
    links.push(`- Convention (${profile.label}) : [${c.label}](${c.url})`);
  }
  return { arborescence: tree.join('\n'), entrees: entries.join('\n'), liens: links.join('\n') };
}

const SERVICES: [RegExp, string][] = [
  [/^@supabase\/supabase-js$/, 'Supabase'], [/^stripe$/, 'Stripe'], [/^resend$/, 'Resend'], [/^@sentry\//, 'Sentry'], [/^posthog/, 'PostHog'],
  [/^@vercel\/analytics$/, 'Vercel Analytics'], [/^openai$/, 'OpenAI'], [/^@anthropic-ai\/sdk$/, 'Anthropic'], [/^nodemailer$/, 'SMTP'],
  [/^@aws-sdk\//, 'AWS'], [/^firebase/, 'Firebase'], [/^@prisma\/client$/, 'Prisma'], [/^pg$|^postgres$/, 'PostgreSQL'], [/^redis$|^ioredis$/, 'Redis'],
];

/** The initial content of the written blocks: a draft to check and complete, never rewritten afterwards. */
export function writtenDrafts(inputs: MapInputs): Record<typeof WRITTEN_BLOCKS[number], string> {
  const { profile, items } = inputs;
  const has = (d: string): boolean => inputs.files.some(f => f.startsWith(`${d}/`));
  const routeRoot = profile.routeRoots.find(has);
  const server = ['src/lib/server', 'server', 'src/server', 'app/api', 'src/app/api'].find(has);
  const shared = ['src/lib', 'lib', 'src'].find(has);
  const migrations = items.find(i => i.kind === 'entry' && i.key.endsWith('migrations/'));
  const services = [...new Set(inputs.dependencies.flatMap(d => SERVICES.filter(([re]) => re.test(d)).map(([, name]) => name)))].sort(byText);
  const crons = items.filter(i => i.kind === 'entry' && (i.key === 'vercel.json' || i.key.startsWith('.github/workflows/') || /tâche planifiée/.test(i.known?.role ?? '')));
  const web = ['sveltekit', 'nextjs', 'nuxt', 'astro', 'angular', 'vue', 'react'].includes(profile.id);
  const flow = ['```mermaid', 'flowchart LR'];
  if (web) flow.push('  nav["Navigateur"]');
  if (routeRoot) flow.push(`  routes["Routes : ${routeRoot}"]`, ...(web ? ['  nav --> routes'] : []));
  if (shared) flow.push(`  lib["Code partagé : ${shared}"]`, routeRoot ? '  routes --> lib' : '');
  if (server) flow.push(`  serveur["Code serveur : ${server}"]`, routeRoot ? '  routes --> serveur' : '');
  if (migrations) flow.push(`  base[("Base de données : ${migrations.key}")]`, server ? '  serveur --> base' : '');
  if (services.length) flow.push(`  ext["Services externes : ${services.join(', ')}"]`, server ? '  serveur --> ext' : '');
  if (crons.length) flow.push(`  cron["Tâches planifiées : ${crons.map(c => c.key).join(', ')}"]`, routeRoot ? '  cron --> routes' : '');
  flow.push('```');
  const rules: string[] = [];
  const doc = (label: string, path: string): void => { if (inputs.files.includes(path)) rules.push(`- ${label} : [${path}](${link(inputs.mapPath, path)})`); };
  doc('Consigne commune (règles de code, contrôles, verrous)', '.apv/brief.md');
  for (const f of inputs.files.filter(x => /^(?:docs\/)?[^/]*(?:secur|sécur|rgpd|privacy|access|acces|donnees|data|test|contribut)[^/]*\.md$/i.test(x)).sort(byText).slice(0, 8)) doc(posix.basename(f, '.md'), f);
  doc('Instructions des agents', 'CLAUDE.md');
  if (!rules.length) rules.push('- Sécurité : à compléter (où sont les règles d\'accès, les en-têtes, les secrets).', '- Données : à compléter.', '- Tests : à compléter.');
  else rules.push('- Sécurité, accès, données, tests : à compléter si un sujet manque ci-dessus.');
  const roles = items.map(i => `- \`${i.key}\` : ${i.known?.role ?? 'à décrire'}`);
  return {
    resume: 'À compléter : ce que fait le projet, pour qui, en deux phrases.',
    flux: ['Brouillon généré à la création : à vérifier et compléter (flux de données, authentification, tâches planifiées).', '', ...flow.filter(Boolean)].join('\n'),
    regles: rules.join('\n'),
    roles: roles.join('\n'),
  };
}

/** The whole map, for a new file. */
export function newMap(inputs: MapInputs): string {
  const drafts = writtenDrafts(inputs);
  const roles = writtenRoles(`${open('roles')}\n${drafts.roles}\n${close('roles')}`);
  const generated = generatedBlocks(inputs, roles);
  const main = inputs.profile.conventions[0];
  const intro = [
    '# Carte de l\'architecture', '',
    `Vue d'ensemble du projet, à lire en premier (cinq minutes), puis la carte du code ([${inputs.codeMapPath}](${link(inputs.mapPath, inputs.codeMapPath)})). Pile : ${inputs.profile.label}${main?.url ? ` ([${main.label}](${main.url}))` : ''}.`,
    'Les parties générées sont réécrites par `apv map` (et `apv structure map`) ; les parties écrites, entre marqueurs `apv:ecrit`, ne sont jamais touchées par l\'outil. Un dossier de premier ou de deuxième niveau, une route principale ou un point d\'entrée ajouté sans rôle dans « Rôles » fait échouer le contrôle `structure`.',
  ];
  const section = (id: BlockId, body: string, note?: string): string[] => ['', `## ${HEADINGS[id]}`, '', ...(note ? [note, ''] : []), open(id), body, close(id)];
  return `${[
    ...intro,
    ...section('resume', drafts.resume),
    ...section('flux', drafts.flux),
    ...section('arborescence', generated.arborescence),
    ...section('entrees', generated.entrees),
    ...section('regles', drafts.regles),
    ...section('liens', generated.liens),
    ...section('roles', drafts.roles, 'Une ligne par dossier, route principale et point d\'entrée, de la forme « - `chemin` : rôle en une ligne ». Un motif `*` décrit plusieurs dossiers (`src/lib/*/`). « à décrire » ne compte pas comme une description.'),
  ].join('\n')}\n`;
}

/**
 * The map with its generated blocks rewritten and everything else kept as it is. A block the file lacks is appended at
 * its end (a written one with its draft): nothing written by hand is ever replaced.
 */
export function refreshMap(current: string, inputs: MapInputs): string {
  const duplicated = duplicateMarkers(current);
  if (duplicated.length) throw new PipelineError('ARCHITECTURE_MAP', `${inputs.mapPath} : marqueur présent plusieurs fois (${duplicated.join(', ')}) ; garder un seul bloc de chaque, puis relancer apv structure map.`);
  const roles = writtenRoles(current);
  const generated = generatedBlocks(inputs, roles);
  const drafts = writtenDrafts(inputs);
  let text = current;
  for (const id of GENERATED_BLOCKS) {
    const start = text.indexOf(open(id));
    const end = text.indexOf(close(id));
    if (start >= 0 && end > start) text = `${text.slice(0, start + open(id).length)}\n${generated[id]}\n${text.slice(end)}`;
    else text = `${text.replace(/\n*$/, '\n')}\n## ${HEADINGS[id]}\n\n${open(id)}\n${generated[id]}\n${close(id)}\n`;
  }
  for (const id of WRITTEN_BLOCKS) {
    if (blockOf(text, id) !== null) continue;
    text = `${text.replace(/\n*$/, '\n')}\n## ${HEADINGS[id]}\n\n${open(id)}\n${drafts[id]}\n${close(id)}\n`;
  }
  return text;
}

export { COMMON_KNOWN };

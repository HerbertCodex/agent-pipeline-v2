import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tree conventions of the common stacks (docs/STRUCTURE.md, « Profils »). The split of a flat folder, the architecture map
 * and the messages of `apv structure check` cite them: a proposal follows a convention a developer of the stack already
 * knows, never a layout invented by the tool. Each convention links to the official documentation of its stack.
 */

/** A convention: a short name, what it says, and where the stack documents it. */
export interface Convention { id: string; label: string; rule: string; url: string }

/** A folder or file the stack knows by name, with its role. `*` matches one path segment. */
export interface KnownPath { path: string; role: string; convention: string }

export interface StackProfile {
  id: string;
  label: string;
  /** Folders whose subfolders the architecture map describes (levels 1 and 2 below them), besides the repository root. */
  anchors: string[];
  /** Folders of file-based routes: their subfolders are URL segments, described as routes, never split. */
  routeRoots: string[];
  /** Folders of components: the generic ones (`ui`) apart from the feature ones. */
  componentRoots: string[];
  conventions: Convention[];
  known: KnownPath[];
  /** Entry points: globs of files the framework calls by name (hooks, layouts, middleware). */
  entries: KnownPath[];
}

const FEATURE = (url: string, where: string): Convention => ({
  id: 'feature-folders', label: 'dossiers par fonctionnalité',
  rule: `un sous-dossier par fonctionnalité (${where}), qui regroupe ce qu'une même fonctionnalité utilise ; les noms reprennent le vocabulaire du projet (routes, dossiers existants)`,
  url,
});
const MIRROR: Convention = {
  id: 'mirror', label: 'même découpage que les composants',
  rule: 'le code d\'une fonctionnalité suit le découpage déjà choisi pour ses composants (même nom de sous-dossier)',
  url: 'https://legacy.reactjs.org/docs/faq-structure.html',
};
const CORE: Convention = {
  id: 'feature-core', label: 'socle de la fonctionnalité à sa racine',
  rule: 'les modules que tout le dossier importe (modèle, vocabulaire, dates) restent à sa racine : ils sont le point d\'entrée du domaine',
  url: 'https://legacy.reactjs.org/docs/faq-structure.html',
};

const SVELTEKIT: StackProfile = {
  id: 'sveltekit', label: 'SvelteKit',
  anchors: ['src/lib'],
  routeRoots: ['src/routes'],
  componentRoots: ['src/lib/components'],
  conventions: [
    { id: 'sveltekit-structure', label: 'structure d\'un projet SvelteKit', rule: 'src/routes pour les routes et leurs fichiers colocalisés, src/lib ($lib) pour le code partagé, src/params, src/hooks.*', url: 'https://svelte.dev/docs/kit/project-structure' },
    { id: 'sveltekit-lib', label: '$lib', rule: 'le code importé par plusieurs routes vit dans src/lib, importé par l\'alias $lib', url: 'https://svelte.dev/docs/kit/$lib' },
    { id: 'sveltekit-params', label: 'validateurs de paramètres', rule: 'src/params/<nom>.ts valide un paramètre de route [x=<nom>]', url: 'https://svelte.dev/docs/kit/advanced-routing' },
    { id: 'sveltekit-hooks', label: 'hooks', rule: 'src/hooks.server.*, src/hooks.client.* et src/hooks.* : fonctions appelées par SvelteKit à chaque requête ou erreur', url: 'https://svelte.dev/docs/kit/hooks' },
    { id: 'sveltekit-server', label: '$lib/server', rule: 'le code serveur uniquement (secrets, base de données) vit dans src/lib/server : SvelteKit refuse qu\'il soit importé par le navigateur', url: 'https://svelte.dev/docs/kit/server-only-modules' },
    FEATURE('https://svelte.dev/docs/kit/$lib', 'src/lib/<fonctionnalité>, src/lib/components/<fonctionnalité>, src/lib/server/<fonctionnalité>'),
    MIRROR, CORE,
  ],
  known: [
    { path: 'src', role: 'sources de l\'application', convention: 'sveltekit-structure' },
    { path: 'src/routes', role: 'routes : une page, un layout ou un point d\'API par dossier, fichiers de la route colocalisés', convention: 'sveltekit-structure' },
    { path: 'src/lib', role: 'code partagé entre les routes, importé par $lib', convention: 'sveltekit-lib' },
    { path: 'src/lib/server', role: 'code serveur uniquement, jamais importé par le navigateur', convention: 'sveltekit-server' },
    { path: 'src/lib/components', role: 'composants Svelte : génériques dans ui/, de fonctionnalité dans un dossier à leur nom', convention: 'feature-folders' },
    { path: 'src/lib/components/ui', role: 'composants génériques (boutons, champs, dialogues), sans logique métier', convention: 'feature-folders' },
    { path: 'src/params', role: 'validateurs des paramètres de route', convention: 'sveltekit-structure' },
    { path: 'static', role: 'fichiers servis tels quels', convention: 'sveltekit-structure' },
    { path: 'tests', role: 'tests hors des sources (navigateur, intégration)', convention: 'sveltekit-structure' },
  ],
  entries: [
    { path: 'src/hooks.server.*', role: 'hooks serveur : exécutés à chaque requête (session, en-têtes, erreurs)', convention: 'sveltekit-hooks' },
    { path: 'src/hooks.client.*', role: 'hooks du navigateur (erreurs inattendues)', convention: 'sveltekit-hooks' },
    { path: 'src/hooks.*', role: 'hooks universels (réécriture d\'URL, transport)', convention: 'sveltekit-hooks' },
    { path: 'src/app.html', role: 'page HTML de base', convention: 'sveltekit-structure' },
    { path: 'src/service-worker.*', role: 'service worker du navigateur', convention: 'sveltekit-structure' },
    { path: 'src/params/*', role: 'validateur de paramètre de route', convention: 'sveltekit-params' },
    { path: 'src/routes/+layout.*', role: 'layout racine : entoure toutes les pages', convention: 'sveltekit-structure' },
    { path: 'src/routes/*/+layout.*', role: 'layout d\'une section ou d\'un groupe de routes', convention: 'sveltekit-structure' },
  ],
};

const NEXT: StackProfile = {
  id: 'nextjs', label: 'Next.js',
  anchors: ['src', 'src/lib', 'src/components', 'lib', 'components'],
  routeRoots: ['app', 'src/app', 'pages', 'src/pages'],
  componentRoots: ['components', 'src/components'],
  conventions: [
    { id: 'next-structure', label: 'structure d\'un projet Next.js', rule: 'app/ (ou pages/) pour les routes, fichiers colocalisés, dossiers privés _dossier, groupes (dossier)', url: 'https://nextjs.org/docs/app/getting-started/project-structure' },
    FEATURE('https://nextjs.org/docs/app/getting-started/project-structure', 'dossiers par fonctionnalité hors de app/, ou colocalisés dans la route'),
    MIRROR, CORE,
  ],
  known: [
    { path: 'app', role: 'routes (app router)', convention: 'next-structure' },
    { path: 'src/app', role: 'routes (app router)', convention: 'next-structure' },
    { path: 'pages', role: 'routes (pages router)', convention: 'next-structure' },
    { path: 'public', role: 'fichiers servis tels quels', convention: 'next-structure' },
    { path: 'components', role: 'composants React partagés', convention: 'feature-folders' },
    { path: 'src/components', role: 'composants React partagés', convention: 'feature-folders' },
    { path: 'lib', role: 'code partagé (accès aux données, utilitaires)', convention: 'next-structure' },
    { path: 'src/lib', role: 'code partagé (accès aux données, utilitaires)', convention: 'next-structure' },
  ],
  entries: [
    { path: 'middleware.*', role: 'middleware : exécuté avant chaque requête', convention: 'next-structure' },
    { path: 'src/middleware.*', role: 'middleware : exécuté avant chaque requête', convention: 'next-structure' },
    { path: 'instrumentation.*', role: 'instrumentation au démarrage du serveur', convention: 'next-structure' },
    { path: 'app/layout.*', role: 'layout racine de l\'application', convention: 'next-structure' },
    { path: 'src/app/layout.*', role: 'layout racine de l\'application', convention: 'next-structure' },
    { path: 'pages/_app.*', role: 'application racine (pages router)', convention: 'next-structure' },
  ],
};

const NUXT: StackProfile = {
  id: 'nuxt', label: 'Nuxt',
  anchors: ['components', 'composables', 'server', 'app/components', 'app/composables'],
  routeRoots: ['pages', 'app/pages', 'server/api', 'server/routes'],
  componentRoots: ['components', 'app/components'],
  conventions: [
    { id: 'nuxt-structure', label: 'structure d\'un projet Nuxt', rule: 'dossiers reconnus par nom : pages, components, composables, layouts, middleware, server, plugins, utils', url: 'https://nuxt.com/docs/guide/directory-structure' },
    FEATURE('https://nuxt.com/docs/guide/directory-structure', 'sous-dossiers par fonctionnalité dans components/ et composables/'),
    MIRROR, CORE,
  ],
  known: ['pages', 'components', 'composables', 'layouts', 'middleware', 'server', 'plugins', 'utils', 'public', 'assets', 'stores'].map(p => ({ path: p, role: `dossier ${p} reconnu par Nuxt`, convention: 'nuxt-structure' })),
  entries: [
    { path: 'app.vue', role: 'composant racine de l\'application', convention: 'nuxt-structure' },
    { path: 'app/app.vue', role: 'composant racine de l\'application', convention: 'nuxt-structure' },
    { path: 'nuxt.config.*', role: 'configuration de Nuxt', convention: 'nuxt-structure' },
    { path: 'middleware/*', role: 'middleware de route', convention: 'nuxt-structure' },
    { path: 'layouts/*', role: 'layout des pages', convention: 'nuxt-structure' },
  ],
};

const ASTRO: StackProfile = {
  id: 'astro', label: 'Astro',
  anchors: ['src', 'src/components'],
  routeRoots: ['src/pages'],
  componentRoots: ['src/components'],
  conventions: [
    { id: 'astro-structure', label: 'structure d\'un projet Astro', rule: 'src/pages pour les routes, src/components, src/layouts, src/content, public', url: 'https://docs.astro.build/en/basics/project-structure/' },
    FEATURE('https://docs.astro.build/en/basics/project-structure/', 'sous-dossiers par fonctionnalité dans src/components'),
    MIRROR, CORE,
  ],
  known: [
    { path: 'src/pages', role: 'routes du site', convention: 'astro-structure' },
    { path: 'src/components', role: 'composants de l\'interface', convention: 'astro-structure' },
    { path: 'src/layouts', role: 'layouts des pages', convention: 'astro-structure' },
    { path: 'src/content', role: 'collections de contenu', convention: 'astro-structure' },
    { path: 'public', role: 'fichiers servis tels quels', convention: 'astro-structure' },
  ],
  entries: [{ path: 'src/middleware.*', role: 'middleware des requêtes', convention: 'astro-structure' }],
};

const ANGULAR: StackProfile = {
  id: 'angular', label: 'Angular',
  anchors: ['src/app'],
  routeRoots: [],
  componentRoots: ['src/app'],
  conventions: [
    { id: 'angular-style', label: 'guide de style Angular', rule: 'organiser le projet par zones fonctionnelles, un fichier par concept, tests à côté du code', url: 'https://angular.dev/style-guide' },
    FEATURE('https://angular.dev/style-guide', 'src/app/<fonctionnalité>'),
    MIRROR, CORE,
  ],
  known: [{ path: 'src/app', role: 'application : un dossier par zone fonctionnelle', convention: 'angular-style' }],
  entries: [{ path: 'src/main.ts', role: 'démarrage de l\'application', convention: 'angular-style' }],
};

const VUE: StackProfile = {
  id: 'vue', label: 'Vue',
  anchors: ['src', 'src/components'],
  routeRoots: ['src/views', 'src/pages'],
  componentRoots: ['src/components'],
  conventions: [
    { id: 'vue-style', label: 'guide de style Vue', rule: 'un composant par fichier, composants de base préfixés et regroupés, noms composés', url: 'https://vuejs.org/style-guide/' },
    FEATURE('https://legacy.reactjs.org/docs/faq-structure.html', 'src/<fonctionnalité> ou src/components/<fonctionnalité>'),
    MIRROR, CORE,
  ],
  known: [{ path: 'src/components', role: 'composants de l\'interface', convention: 'vue-style' }],
  entries: [{ path: 'src/main.*', role: 'démarrage de l\'application', convention: 'vue-style' }, { path: 'src/App.vue', role: 'composant racine de l\'application', convention: 'vue-style' }],
};

const REACT: StackProfile = {
  id: 'react', label: 'React',
  anchors: ['src', 'src/components', 'src/features'],
  routeRoots: [],
  componentRoots: ['src/components'],
  conventions: [
    { id: 'react-structure', label: 'organisation d\'un projet React', rule: 'regrouper par fonctionnalité ou par route, éviter l\'imbrication profonde', url: 'https://legacy.reactjs.org/docs/faq-structure.html' },
    FEATURE('https://legacy.reactjs.org/docs/faq-structure.html', 'src/features/<fonctionnalité> ou src/<fonctionnalité>'),
    MIRROR, CORE,
  ],
  known: [{ path: 'src/components', role: 'composants partagés de l\'interface', convention: 'react-structure' }, { path: 'public', role: 'fichiers servis tels quels', convention: 'react-structure' }],
  entries: [{ path: 'src/main.*', role: 'démarrage de l\'application', convention: 'react-structure' }, { path: 'src/index.*', role: 'démarrage de l\'application', convention: 'react-structure' }, { path: 'src/App.*', role: 'composant racine de l\'application', convention: 'react-structure' }],
};

const PYTHON: StackProfile = {
  id: 'python', label: 'Python',
  anchors: ['src'],
  routeRoots: [],
  componentRoots: [],
  conventions: [
    { id: 'python-structure', label: 'structure d\'un projet Python', rule: 'un paquet par domaine, modules courts, tests dans tests/', url: 'https://docs.python-guide.org/writing/structure/' },
    { id: 'django-apps', label: 'applications Django', rule: 'une application Django par domaine (models, views, urls, tests)', url: 'https://docs.djangoproject.com/en/stable/intro/reusable-apps/' },
    FEATURE('https://docs.python-guide.org/writing/structure/', 'un sous-paquet par domaine'),
    CORE,
  ],
  known: [{ path: 'tests', role: 'tests du projet', convention: 'python-structure' }, { path: 'src', role: 'paquets de l\'application', convention: 'python-structure' }],
  entries: [{ path: 'manage.py', role: 'commande de gestion Django', convention: 'django-apps' }, { path: '*/settings.py', role: 'réglages du projet Django', convention: 'django-apps' }, { path: '*/urls.py', role: 'routes du projet Django', convention: 'django-apps' }],
};

const GO: StackProfile = {
  id: 'go', label: 'Go',
  anchors: ['internal', 'cmd', 'pkg'],
  routeRoots: [],
  componentRoots: [],
  conventions: [
    { id: 'go-layout', label: 'organisation d\'un module Go', rule: 'cmd/<programme> pour les exécutables, internal/<paquet> pour le code privé, un paquet par domaine', url: 'https://go.dev/doc/modules/layout' },
    FEATURE('https://go.dev/doc/modules/layout', 'internal/<domaine>'),
    CORE,
  ],
  known: [{ path: 'cmd', role: 'programmes (un dossier par exécutable)', convention: 'go-layout' }, { path: 'internal', role: 'paquets privés du module', convention: 'go-layout' }, { path: 'pkg', role: 'paquets réutilisables du module', convention: 'go-layout' }],
  entries: [{ path: 'main.go', role: 'programme principal du module', convention: 'go-layout' }, { path: 'cmd/*/main.go', role: 'point d\'entrée d\'un programme', convention: 'go-layout' }],
};

const GENERIC: StackProfile = {
  id: 'generic', label: 'projet sans pile reconnue',
  anchors: ['src', 'lib'],
  routeRoots: [],
  componentRoots: ['src/components', 'components'],
  conventions: [
    FEATURE('https://legacy.reactjs.org/docs/faq-structure.html', 'un sous-dossier par fonctionnalité'),
    MIRROR, CORE,
  ],
  known: [{ path: 'src', role: 'sources du projet', convention: 'feature-folders' }, { path: 'tests', role: 'tests du projet', convention: 'feature-folders' }],
  entries: [],
};

/** Folders and files every project may have, whatever its stack: migrations, scheduled tasks, CI. */
export const COMMON_KNOWN: KnownPath[] = [
  { path: 'docs', role: 'documentation du projet', convention: 'common' },
  { path: 'scripts', role: 'scripts de développement et d\'exploitation', convention: 'common' },
  { path: 'supabase', role: 'base Supabase : migrations, fonctions, configuration locale', convention: 'common' },
  { path: 'supabase/migrations', role: 'migrations de la base, appliquées dans l\'ordre', convention: 'common' },
  { path: 'supabase/functions', role: 'fonctions Edge de Supabase', convention: 'common' },
  { path: 'prisma', role: 'schéma et migrations Prisma', convention: 'common' },
  { path: 'migrations', role: 'migrations de la base', convention: 'common' },
  { path: 'e2e', role: 'tests navigateur de bout en bout', convention: 'common' },
];

export const PROFILES: readonly StackProfile[] = [SVELTEKIT, NEXT, NUXT, ASTRO, ANGULAR, VUE, REACT, PYTHON, GO, GENERIC];

/** A profile by id; the generic one for an unknown id. */
export function profileById(id: string): StackProfile {
  return PROFILES.find(p => p.id === id) ?? GENERIC;
}

function dependencies(repo: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as Record<string, unknown>;
    return new Set(Object.keys({ ...(pkg['dependencies'] as object ?? {}), ...(pkg['devDependencies'] as object ?? {}) }));
  } catch { return new Set(); }
}

/** The stack of the repository, from its dependencies and marker files; `generic` when none is recognised. */
export function detectProfile(repo: string, files: readonly string[] = []): StackProfile {
  const deps = dependencies(repo);
  const has = (path: string): boolean => files.includes(path) || existsSync(join(repo, path));
  if (deps.has('@sveltejs/kit')) return SVELTEKIT;
  if (deps.has('next')) return NEXT;
  if (deps.has('nuxt')) return NUXT;
  if (deps.has('astro')) return ASTRO;
  if (deps.has('@angular/core')) return ANGULAR;
  if (deps.has('vue')) return VUE;
  if (deps.has('react')) return REACT;
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('manage.py')) return PYTHON;
  if (has('go.mod')) return GO;
  return GENERIC;
}

/** The convention of an id, in this profile (or the common folders); null when unknown. */
export function conventionOf(profile: StackProfile, id: string): Convention | null {
  if (id === 'common') return { id: 'common', label: 'dossier courant', rule: 'dossier courant d\'un dépôt', url: '' };
  return profile.conventions.find(c => c.id === id) ?? null;
}

/** `*` matches one path segment (never a `/`). */
export function segmentGlob(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}$`);
}

/** The known path (folder or file) that describes `path`, or null. */
export function knownPath(profile: StackProfile, path: string, list: readonly KnownPath[] = [...profile.known, ...COMMON_KNOWN]): KnownPath | null {
  return list.find(k => k.path === path) ?? list.find(k => k.path.includes('*') && segmentGlob(k.path).test(path)) ?? null;
}

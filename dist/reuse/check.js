import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { CODE_EXTENSIONS, parseName } from '../structure/names.js';
import { buildCodeMap, clashesFor } from '../knowledge/code-map.js';
import { collectChanges, isAdded, readAtBase, readWorktree, resolveBase } from './changes.js';
import { COMPONENT_EXTENSIONS, DEFAULT_PRIMITIVE_PATHS, DEFAULT_STYLE_SOURCES, ELEMENT_FAMILIES, GENERATED_HEADER, GENERATED_PATHS, REUSE_RULES, outputMatcher, STYLE_EXTENSIONS, UI_EXTENSIONS, extensionOf, globMatcher, mapSettings, reuseSettings, } from './config.js';
import { TokenTable, blankImports, findClones, occurs, tokenize } from './duplicates.js';
import { blocks, elementRule, findElements } from './markup.js';
import { componentName, describeClash, replacementFor } from './names.js';
import { Primitives, isLayoutOnly, primitivesOf, restyledPrimitives, styleRules } from './styles.js';
import { environment } from '../execution/process.js';
import { rangesOf } from './markup.js';
import { breakableValues, typographyPatterns } from './typography.js';
const SCRIPT_EXTENSIONS = new Set(['ts', 'js', 'mjs', 'cjs', 'mts', 'cts']);
const LOCALE_FILE = /(?:^|\/)(?:locales?|i18n|messages|lang|translations)\//;
/** Content of a file at a commit, or null (absent, unreadable, larger than 4 MB); Git runs with the environment of the checks only. */
function gitShow(repo, spec) {
    try {
        return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--no-pager', 'show', '--no-textconv', '--end-of-options', spec], {
            cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024, timeout: 30_000,
            env: { ...environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG']), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
        });
    }
    catch {
        return null;
    }
}
/** Extensions a rule reads: the only files whose first lines are read to tell a generated one. */
const READ_EXTENSIONS = (ext) => CODE_EXTENSIONS.has(ext) || UI_EXTENSIONS.has(ext) || STYLE_EXTENSIONS.has(ext) || ext === 'json';
const order = (a, b) => REUSE_RULES.indexOf(a.rule) - REUSE_RULES.indexOf(b.rule) || Number(b.isNew) - Number(a.isNew) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line;
/**
 * `apv reuse check` (docs/REUSE.md): what a change adds against the existing components of the project. Every rule
 * reports what the change adds (new) and what was already there (existing, never blocking), so that a project with a
 * history adopts the check without first cleaning everything.
 */
export async function checkReuse(repo, config, options = {}) {
    const settings = reuseSettings(config.reuse);
    const mapConfig = mapSettings(config.map);
    const changes = options.changes ?? await collectChanges(repo, resolveBase(repo, options.base, settings.reference));
    const designDir = config.design?.dir?.replace(/\/+$/, '');
    const ignored = globMatcher([...settings.ignore, ...(designDir ? [`${designDir}/**`] : [])]);
    const cache = new Map();
    const read = (path) => {
        if (!cache.has(path))
            cache.set(path, readWorktree(repo, path));
        return cache.get(path);
    };
    // Generated files (database types, clients): left out of every rule, listed apart, never counted. A name or a mention
    // is trusted only if the file was already generated at the base, or declared in `reuse.generated`: otherwise a name
    // (`shell.gen.css`, `generated/`) or a comment would be enough to take a copy out of the check. Interface files never are.
    const generatedName = globMatcher([...GENERATED_PATHS]);
    const declared = globMatcher(settings.generated);
    const output = outputMatcher(changes.files);
    const generated = [];
    const excluded = [];
    const claimed = [];
    const header = (text) => GENERATED_HEADER.test((text ?? '').slice(0, 600));
    const files = changes.files.filter(path => {
        const ext = extensionOf(path);
        if (ignored(path) || output(path)) {
            if (ext !== 'json' && READ_EXTENSIONS(ext))
                excluded.push(path);
            return false;
        }
        if (UI_EXTENSIONS.has(ext))
            return true;
        if (declared(path)) {
            generated.push(path);
            return false;
        }
        const byName = generatedName(path);
        if (!byName && !(READ_EXTENSIONS(ext) && header(read(path))))
            return true;
        let trusted = changes.all;
        if (!trusted) {
            const before = readAtBase(repo, changes, path, gitShow);
            trusted = before !== null && (byName ? generatedName(changes.renamed.get(path) ?? path) : header(before));
        }
        if (trusted) {
            generated.push(path);
            return false;
        }
        claimed.push({ path, how: byName ? 'name' : 'header' });
        return true;
    });
    const isTest = (path) => parseName(path)?.test ?? /(?:^|\/)(?:tests?|__tests__|e2e|fixtures)\//.test(path);
    let map = null;
    const codeMap = async () => (map ??= await buildCodeMap(repo, settings, mapConfig, { read }));
    const findings = [];
    const summary = Object.fromEntries(REUSE_RULES.map(rule => [rule, { severity: settings.severity[rule], active: settings.severity[rule] !== 'off', note: null, new: 0, existing: 0 }]));
    const add = (finding, override) => {
        const severity = (override ?? settings.severity[finding.rule]);
        findings.push({ ...finding, severity, blocking: severity === 'error' && finding.isNew });
    };
    for (const { path, how } of claimed) {
        add({ rule: 'duplicates', isNew: true, path, line: 1,
            message: `${how === 'name' ? 'nommé comme un fichier généré' : 'mention « fichier généré » en tête'}, mais ${how === 'name' ? 'créé par le changement (absent à la base)' : 'ajoutée par le changement (absente à la base)'} : un fichier ne sort pas du contrôle par son nom ni par un commentaire, il reste analysé. S'il est vraiment écrit par un outil, déclarez-le dans reuse.generated de .apv/config.json (motif de chemin), avec l'accord de l'opérateur.` }, 'error');
    }
    if (summary.native.active)
        await nativeRule(settings, files, read, isTest, changes, codeMap, add);
    const primitives = summary.styles.active ? stylesRule(settings, files, read, isTest, changes, add, summary.styles) : { sources: [], count: 0 };
    if (summary.duplicates.active)
        duplicatesRule(repo, settings, files, read, isTest, changes, add);
    if (summary.names.active) {
        const current = await codeMap();
        for (const component of current.components) {
            if (!changes.all && !changes.created.has(component.path))
                continue;
            if (ignored(component.path))
                continue;
            const clashes = changes.all ? component.clashes : clashesFor(current, component.path, settings.roles, true);
            if (!clashes.length)
                continue;
            // Strong: it redoes a generic shared component of the structure or of the design system (`AdminToast` next to
            // `ToastRegion`, `AdminShell` next to `Sidebar`) without composing it (composition is never a clash).
            // Same family exactly (a toast next to the toast, a dialog next to the dialog); a layout next to the side bar, or a
            // part named after it (`SidebarSection`), stays a warning.
            const strong = clashes.filter(c => { const shared = componentName(c.with, settings.roles); return shared.generic && shared.family !== null && c.family === shared.family && settings.strong.includes(shared.family); });
            const severity = strong.length && settings.strongSeverity !== 'off' ? settings.strongSeverity : undefined;
            const listed = strong.length ? strong : clashes;
            add({ rule: 'names', isNew: true, path: component.path, line: 1, other: { path: listed[0].with, line: 1 },
                message: strong.length
                    ? `refait ${listed.map(c => `${c.with} (rôle ${componentName(c.with, settings.roles).family})`).join(', ')}, ${listed.length > 1 ? 'composants partagés génériques' : 'composant partagé générique'} : l'utiliser, ou le composer (l'importer et l'envelopper), ou l'étendre (paramètre, variante) ; jamais une copie propre à une fonctionnalité.`
                    : `${clashes.map(describeClash).join(' ; ')}, ${clashes.length > 1 ? 'composants partagés' : 'composant partagé'} : le réutiliser ou l'étendre (paramètre, variante), sinon justifier ce nouveau composant dans le rapport.` }, severity);
        }
    }
    if (summary.typography.active) {
        const patterns = typographyPatterns(settings.locale);
        if (!patterns) {
            summary.typography.active = false;
            summary.typography.note = settings.locale
                ? `la langue « ${settings.locale} » n'exige pas d'espace insécable dans ces valeurs : règle inactive`
                : 'langue des textes non déclarée (reuse.typography.locale) : règle inactive';
        }
        else {
            for (const path of files) {
                const ext = extensionOf(path);
                const markup = UI_EXTENSIONS.has(ext);
                if (isTest(path) || !(markup || SCRIPT_EXTENSIONS.has(ext) || (ext === 'json' && LOCALE_FILE.test(path))))
                    continue;
                const whole = changes.all || changes.created.has(path);
                const lines = whole ? undefined : changes.added.get(path);
                if (!whole && !lines?.size)
                    continue;
                const text = read(path);
                if (text === null)
                    continue;
                for (const hit of breakableValues(text, ext, patterns, markup, lines)) {
                    add({ rule: 'typography', isNew: true, path, line: hit.line,
                        message: `${hit.values.join(', ')} : espace insécable attendue (U+00A0, ou fine U+202F ; &nbsp; ou &#8239; dans le balisage, \\u00a0 ou \\u202f dans une chaîne), sinon la valeur se coupe en fin de ligne.` });
                }
            }
        }
    }
    for (const finding of findings)
        summary[finding.rule][finding.isNew ? 'new' : 'existing']++;
    findings.sort(order);
    return { ok: !findings.some(f => f.blocking), base: changes.base, analyzedFiles: files.length, rules: summary, findings, primitives,
        generated: { count: generated.length, files: generated.slice(0, 20) }, excluded: { count: excluded.length, files: excluded.slice(0, 20) } };
}
async function nativeRule(settings, files, read, isTest, changes, codeMap, add) {
    const rules = Object.keys(settings.native.elements).sort().map(elementRule);
    const allowed = globMatcher(settings.native.allowedPaths);
    const preferred = globMatcher([...DEFAULT_PRIMITIVE_PATHS, ...settings.native.allowedPaths]);
    let shared = null;
    for (const path of files) {
        if (!UI_EXTENSIONS.has(extensionOf(path)) || allowed(path) || isTest(path))
            continue;
        const text = read(path);
        if (text === null)
            continue;
        for (const hit of findElements(text, rules, extensionOf(path))) {
            let target = settings.native.elements[hit.selector] ?? null;
            if (target === null) {
                shared ??= (await codeMap()).components.filter(c => c.shared).map(c => c.path);
                const family = ELEMENT_FAMILIES[elementRule(hit.selector).tag];
                target = family ? replacementFor(shared, family, settings.roles, preferred) : null;
            }
            // The shared component that wraps the element is its replacement: never reported against itself.
            if (target === path)
                continue;
            const tag = hit.selector.replace(/^([a-z0-9-]+)(.*)$/, '<$1$2>');
            add({ rule: 'native', isNew: isAdded(changes, path, hit.line), path, line: hit.line,
                message: target
                    ? `${tag} natif réservé aux composants partagés : utiliser ${target}.`
                    : `${tag} natif réservé aux composants partagés (${settings.native.allowedPaths.join(', ')}) : aucun composant partagé ne le remplace encore ; en créer un là, paramétrable, et le déclarer dans reuse.native.elements.` });
        }
    }
}
function stylesRule(settings, files, read, isTest, changes, add, summary) {
    const present = new Set(files);
    const declared = settings.styles.sources
        ? files.filter(globMatcher(settings.styles.sources))
        : DEFAULT_STYLE_SOURCES.filter(path => present.has(path));
    // The sheets a global sheet imports (`@import './styles/buttons.css'`) are global too.
    const sources = [];
    const queue = [...declared];
    while (queue.length && sources.length < 50) {
        const path = queue.shift();
        if (sources.includes(path))
            continue;
        sources.push(path);
        for (const m of (read(path) ?? '').matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g)) {
            const target = m[1];
            if (!target.startsWith('.'))
                continue;
            const resolved = posix.normalize(posix.join(posix.dirname(path), target));
            if (present.has(resolved))
                queue.push(resolved);
        }
    }
    const classes = sources.flatMap(path => primitivesOf(read(path) ?? ''));
    const primitives = new Primitives(classes, settings.styles.selectors, settings.styles.except);
    if (!primitives.size) {
        summary.active = false;
        summary.note = sources.length ? `aucune classe primitive dans ${sources.join(', ')} : règle inactive` : 'aucune feuille globale trouvée (reuse.styles.sources) : règle inactive';
        return { sources, count: 0 };
    }
    const allowed = globMatcher([...settings.styles.allowedPaths, ...sources]);
    const sourceList = sources.length ? sources.join(', ') : 'reuse.styles.selectors';
    for (const path of files) {
        const ext = extensionOf(path);
        const markup = UI_EXTENSIONS.has(ext);
        if (allowed(path) || isTest(path) || !(markup || STYLE_EXTENSIONS.has(ext)))
            continue;
        const text = read(path);
        if (text === null)
            continue;
        const rules = markup ? blocks(text, 'style').flatMap(b => styleRules(b.content, b.line)) : styleRules(text);
        for (const hit of restyledPrimitives(rules, primitives)) {
            if (hit.nested && (settings.styles.nested === 'allow' || (settings.styles.nested === 'layout' && isLayoutOnly(hit.properties))))
                continue;
            add({ rule: 'styles', isNew: isAdded(changes, path, hit.line), path, line: hit.line,
                message: hit.nested
                    ? `« ${hit.selector} » ajuste la primitive .${hit.primitive} (${sourceList}) sous une classe du composant avec ${hit.properties.filter(p => settings.styles.nested === 'refuse' || !isLayoutOnly([p])).join(', ') || 'des propriétés'}${settings.styles.nested === 'layout' ? ' (seule la mise en page est permise : marges, largeur, alignement, ordre, position)' : ''} : ajouter une variante à la primitive ou au composant partagé.`
                    : `« ${hit.selector} » redéfinit la primitive .${hit.primitive} (${sourceList}) dans un style local : utiliser la classe telle quelle, ou ajouter une variante à la primitive ou au composant partagé.` });
        }
    }
    return { sources, count: primitives.size };
}
function duplicatesRule(repo, settings, files, read, isTest, changes, add) {
    const shared = globMatcher(settings.shared);
    const primitive = globMatcher([...DEFAULT_PRIMITIVE_PATHS, ...settings.native.allowedPaths]);
    /** A generic shared component: a component of the shared folders whose name is only its role, or of the primitives. */
    const genericShared = (path) => COMPONENT_EXTENSIONS.has(extensionOf(path)) && shared(path) && (primitive(path) || componentName(path, settings.roles).generic);
    // Lines of style: whole style sheets, and the `<style>` blocks of interface files.
    const styleLines = new Map();
    const inStyle = (path, from, to) => {
        let ranges = styleLines.get(path);
        if (!ranges) {
            const ext = extensionOf(path);
            ranges = STYLE_EXTENSIONS.has(ext) ? 'all' : UI_EXTENSIONS.has(ext) ? rangesOf(read(path) ?? '', 'style') : [];
            styleLines.set(path, ranges);
        }
        return ranges === 'all' || ranges.some(([a, b]) => from >= a && to <= b);
    };
    const included = settings.duplicates.paths ? globMatcher(settings.duplicates.paths) : (path) => {
        const ext = extensionOf(path);
        return CODE_EXTENSIONS.has(ext) || STYLE_EXTENSIONS.has(ext) || COMPONENT_EXTENSIONS.has(ext) || ext === 'html';
    };
    const excluded = globMatcher(settings.duplicates.ignore);
    const table = new TokenTable();
    const tokens = new Map();
    for (const path of files) {
        if (!included(path) || excluded(path) || isTest(path))
            continue;
        const text = read(path);
        if (text !== null)
            tokens.set(path, tokenize(blankImports(text, extensionOf(path)), extensionOf(path), table));
    }
    const options = { minTokens: settings.duplicates.minTokens, minLines: settings.duplicates.minLines };
    const baseIds = new Map();
    const atBase = (path) => {
        if (!baseIds.has(path)) {
            const text = readAtBase(repo, changes, path, gitShow);
            baseIds.set(path, text === null ? null : Int32Array.from(tokenize(blankImports(text, extensionOf(path)), extensionOf(path), table), t => t.id));
        }
        return baseIds.get(path);
    };
    const touched = (path, from, to) => {
        if (changes.all || changes.created.has(path))
            return true;
        const lines = changes.added.get(path);
        if (!lines)
            return false;
        for (let l = from; l <= to; l++)
            if (lines.has(l))
                return true;
        return false;
    };
    for (const found of findClones(tokens, options)) {
        // The finding sits on the copy the change adds or modifies, never on the original it copies.
        const swap = !touched(found.a.path, found.a.startLine, found.a.endLine) && touched(found.b.path, found.b.startLine, found.b.endLine);
        const clone = swap ? { ...found, a: found.b, b: found.a } : found;
        let isNew = touched(clone.a.path, clone.a.startLine, clone.a.endLine) || touched(clone.b.path, clone.b.startLine, clone.b.endLine);
        // Touched but already duplicated at the base (same tokens in both files there): the copy is not the change's.
        if (isNew && !changes.all) {
            const needle = Int32Array.from(tokens.get(clone.a.path).slice(clone.a.start, clone.a.end + 1), t => t.id);
            const a = atBase(clone.a.path);
            const b = atBase(clone.b.path);
            if (a && b && (clone.a.path === clone.b.path ? occurs(a, needle, true) : occurs(a, needle) && occurs(b, needle)))
                isNew = false;
        }
        // Style declarations only: their own severity (`duplicates.styles`, warning by default).
        const styles = inStyle(clone.a.path, clone.a.startLine, clone.a.endLine) && inStyle(clone.b.path, clone.b.startLine, clone.b.endLine);
        // Styles copied from a generic shared component (its look redone elsewhere) are a copy of the interface: the severity
        // of code copies. Only styles copied between components of features take `duplicates.styles`.
        const fromShared = genericShared(clone.a.path) || genericShared(clone.b.path);
        const severity = styles && !fromShared ? settings.duplicates.styles : settings.severity.duplicates;
        if (severity === 'off')
            continue;
        add({ rule: 'duplicates', isNew, path: clone.a.path, line: clone.a.startLine, endLine: clone.a.endLine,
            other: { path: clone.b.path, line: clone.b.startLine, endLine: clone.b.endLine },
            message: `${styles ? `styles identiques à${fromShared ? ' ceux du composant partagé' : ''}` : 'bloc identique à'} ${clone.b.path}:${clone.b.startLine}-${clone.b.endLine} (${clone.lines} lignes, ${clone.tokens} jetons) : ${styles ? 'les mettre dans une primitive ou une variante partagée' : 'le factoriser dans un module ou un composant partagé et paramétrable'}, puis retirer la copie.` }, severity);
    }
}
//# sourceMappingURL=check.js.map
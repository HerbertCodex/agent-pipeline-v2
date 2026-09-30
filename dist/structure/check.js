import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { Git } from '../execution/git.js';
import { loadConfigAtCommit } from '../config/load.js';
import { buildCodeMap } from '../knowledge/code-map.js';
import { mapSettings, reuseSettings } from '../reuse/config.js';
import { collectChanges, readWorktree, resolveBase } from '../reuse/changes.js';
import { designDir } from '../design/config.js';
import { environment } from '../execution/process.js';
import { analyzeStructure } from './analyze.js';
import { archItems, brokenLinks, roleOf, writtenRoles } from './archmap.js';
import { structureSettings } from './config.js';
import { parseName } from './names.js';
import { detectProfile, profileById } from './profiles.js';
import { usageFromMap } from './split.js';
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const inside = (path, dir) => dir === '.' || path === dir || path.startsWith(`${dir}/`);
/** Main files per folder (stems of code files that are not tests), as `flat-folder` counts them. */
export function folderEntries(paths, settings) {
    const out = new Map();
    for (const p of paths) {
        if (settings.ignore.some(re => re.test(p)))
            continue;
        const f = parseName(p);
        if (!f || f.test || !settings.roots.some(r => inside(p, r)))
            continue;
        const stems = out.get(f.dir) ?? new Map();
        const known = stems.get(f.stem);
        // The main file of a stem: fewest name parts (`x.ts` before `x.svelte.ts`), then the name.
        if (!known || f.infixes.length < (parseName(known)?.infixes.length ?? 0) || (f.infixes.length === (parseName(known)?.infixes.length ?? 0) && p < known))
            stems.set(f.stem, p);
        out.set(f.dir, stems);
    }
    return out;
}
/** The usage graph of the working tree, from the code map (who imports whom, what modules export). */
export async function usageGraph(repo, config) {
    const map = await buildCodeMap(repo, reuseSettings(config.reuse), mapSettings(config.map));
    return usageFromMap(map);
}
function stable(value) {
    if (Array.isArray(value))
        return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}
/** The stack profile: `structure.profile`, else detected. */
export function profileOf(repo, settings, files) {
    return settings.profile ? profileById(settings.profile) : detectProfile(repo, files);
}
function dependencies(repo) {
    try {
        const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
        return Object.keys({ ...(pkg['dependencies'] ?? {}), ...(pkg['devDependencies'] ?? {}) }).sort(byText);
    }
    catch {
        return [];
    }
}
/** Everything the architecture map is written from. */
export function mapInputs(repo, config, settings, files, report) {
    // The map is part of the tree it describes (its folder included), even before it is written.
    files = [...new Set([...files, settings.architectureMap])].sort(byText);
    const profile = profileOf(repo, settings, files);
    const read = (path) => readWorktree(repo, path);
    const flat = report.findings.filter(f => f.code === 'flat-folder');
    return {
        mapPath: settings.architectureMap,
        profile,
        items: archItems(files, profile, settings, read),
        files,
        designDir: existsSync(join(repo, designDir(config.design))) ? designDir(config.design) : null,
        codeMapPath: mapSettings(config.map).file,
        maxFlatFiles: settings.maxFlatFiles,
        crowded: flat.map(f => ({ folder: f.folder, code: f.files.length, groups: (f.groups ?? []).map(g => g.dir) })),
        dependencies: dependencies(repo),
        read,
    };
}
/**
 * `apv structure check` (docs/STRUCTURE.md). Without base: the analysis of the tracked files, and the architecture map
 * signalled without blocking. With `--base`: the configuration of the base judges the change (it never loosens its own
 * check); what the change adds is compared with the base: a code file added to a flat folder (or that makes one), a
 * folder, main route or entry point without role in the architecture map, a link of the map the change breaks. What
 * existed at the base is signalled without blocking; moves that empty a flat folder into its subfolders are accepted.
 */
export async function checkStructure(repo, config, options = {}) {
    const git = new Git();
    const changes = options.base !== undefined ? options.changes ?? await collectChanges(repo, resolveBase(repo, options.base, null)) : null;
    const mergeBase = changes?.base.mergeBase ?? null;
    let judged = config;
    const out = [];
    const codeTouched = () => !!changes && changes.files.some(f => (changes.created.has(f) || changes.renamed.has(f) || (changes.added.get(f)?.size ?? 0) > 0) && parseName(f) !== null);
    if (mergeBase) {
        const atBase = loadConfigAtCommit(repo, mergeBase);
        if (atBase.file) {
            judged = { ...config, structure: atBase.config.structure };
            if (stable(config.structure ?? null) !== stable(atBase.config.structure ?? null)) {
                const blocking = codeTouched();
                out.push({ code: 'configuration', severity: blocking ? 'error' : 'warning', isNew: true, blocking, path: atBase.file.slice(atBase.file.indexOf(':') + 1),
                    message: 'section structure de la configuration modifiée par le changement : le contrôle juge avec celle de la base ; c\'est une décision de l\'opérateur, à fusionner dans une PR de configuration à part.' });
            }
        }
    }
    const settings = structureSettings(judged.structure);
    let usage = options.usage === undefined ? null : options.usage;
    let usageError = null;
    if (options.usage === undefined) {
        try {
            usage = await usageGraph(repo, config);
        }
        catch (error) {
            usageError = error instanceof Error ? error.message : String(error);
        }
    }
    const files = changes ? changes.files : options.tracked ?? (await git.exec(repo, ['ls-files', '--cached', '--deduplicate', '-z'])).split('\0').filter(Boolean);
    const report = analyzeStructure(files, settings, { ...(options.paths?.length ? { paths: options.paths } : {}), ...(usage ? { usage } : {}) });
    const wanted = (dir) => !options.paths?.length || options.paths.some(p => inside(dir, p));
    // What the change moves or creates: the analysis findings on those files are new; the others existed.
    const touchedPaths = new Set(changes && !changes.all ? [...changes.created, ...changes.renamed.keys()] : []);
    for (const f of report.findings) {
        const isNew = !changes || changes.all || f.files.some(p => touchedPaths.has(p));
        Object.assign(f, { isNew, blocking: f.severity === 'error' && isNew });
    }
    const baseFiles = mergeBase ? (await git.exec(repo, ['ls-tree', '-r', '--name-only', '-z', mergeBase])).split('\0').filter(Boolean) : null;
    // Flat folders: an added code file blocks, what was there is signalled by the analysis.
    if (changes && baseFiles && !changes.all) {
        const now = folderEntries(files, settings);
        const before = folderEntries(baseFiles, settings);
        const max = settings.maxFlatFiles;
        for (const [dir, stems] of [...now].sort((a, b) => byText(a[0], b[0]))) {
            if (stems.size <= max || !wanted(dir))
                continue;
            const had = before.get(dir) ?? new Map();
            for (const [stem, main] of [...stems].sort((a, b) => byText(a[0], b[0]))) {
                if (had.has(stem))
                    continue;
                const from = changes.renamed.get(main);
                if (from) {
                    const origin = posix.dirname(from);
                    // Renamed in place, or moved down from a flat folder into one of its subfolders: never an addition.
                    if (origin === dir)
                        continue;
                    if (dir.startsWith(`${origin}/`) && (before.get(origin)?.size ?? 0) > max)
                        continue;
                }
                const flat = report.findings.find(f => f.folder === dir && f.code === 'flat-folder');
                const group = flat?.groups?.find(g => g.members.includes(main));
                const core = flat?.core?.find(c => c.path === main);
                const others = group?.members.filter(m => m !== main).map(m => posix.basename(m)) ?? [];
                // Placed by a rule of names (prefix, role, neighbouring folder): the move of the plan.
                const byName = report.findings.find(f => f.folder === dir && f.code !== 'flat-folder' && f.moves.some(m => m.from === main));
                const move = byName?.moves.find(m => m.from === main);
                const where = group
                    ? `à ranger dans ${dir}/${group.dir}/ (${group.existing ? 'sous-dossier existant' : 'sous-dossier proposé'}${others.length ? ` avec ${others.slice(0, 4).join(', ')}${others.length > 4 ? ', …' : ''}` : ''} ; ${group.reasons[0]})`
                    : move ? `à ranger en ${move.to} (${byName.code} : ${byName.proposal.replace(/[.\s]+$/, '')})`
                        : core ? 'fichier que le dossier importe beaucoup : le ranger d\'abord avec l\'opérateur (apv structure check --path) plutôt que d\'alourdir la racine'
                            : `aucun groupe ne s'impose : le placer dans un sous-dossier de fonctionnalité (apv structure check --path ${dir} donne le découpage proposé), décidé avec l'opérateur`;
                const size = had.size > max ? `${dir}/ a déjà ${had.size} fichiers de code (seuil ${max})` : `${dir}/ passe de ${had.size} à ${stems.size} fichiers de code (seuil ${max})`;
                const severity = settings.severity['flat-growth'];
                out.push({ code: 'flat-growth', severity, isNew: true, blocking: severity === 'error', path: main, message: `fichier de code ajouté à un dossier à plat : ${size} ; ${where}.` });
            }
        }
    }
    // Architecture map.
    const profile = profileOf(repo, settings, files);
    const mapPath = settings.architectureMap;
    const mapText = readWorktree(repo, mapPath);
    const roles = writtenRoles(mapText);
    const items = archItems(files, profile, settings, p => readWorktree(repo, p));
    const scoped = (item) => !options.paths?.length || (item.kind === 'folder' && wanted(item.key.replace(/\/$/, '')));
    const undescribed = items.filter(i => scoped(i) && roleOf(i, roles) === null);
    const severity = settings.severity['architecture-map'];
    const label = { folder: 'dossier', route: 'route principale', entry: 'point d\'entrée' };
    const added = { folder: ['ajouté', 'existant'], route: ['ajoutée', 'existante'], entry: ['ajouté', 'existant'] };
    if (!changes) {
        if (mapText === null)
            out.push({ code: 'architecture-map', severity: 'warning', isNew: false, blocking: false, path: mapPath, message: `carte de l'architecture absente : apv structure map l'écrit (partie générée remplie, partie écrite à compléter).` });
        else
            for (const i of undescribed)
                out.push({ code: 'architecture-map', severity: 'warning', isNew: false, blocking: false, path: mapPath, message: `${label[i.kind]} ${i.key} sans rôle dans « Rôles ».` });
        for (const b of mapText === null ? [] : brokenLinks(mapText, mapPath, p => existsSync(join(repo, p)))) {
            out.push({ code: 'architecture-map', severity: 'warning', isNew: false, blocking: false, path: `${mapPath}:${b.line}`, message: `lien cassé : ${b.target}.` });
        }
    }
    else if (baseFiles) {
        const baseKeys = new Set(archItems(baseFiles, profile, settings, p => gitShow(repo, mergeBase, p)).map(i => i.key));
        const baseMapPath = structureSettings(judged.structure).architectureMap;
        const baseMap = gitShow(repo, mergeBase, baseMapPath);
        if (mapText === null && baseMap !== null) {
            out.push({ code: 'architecture-map', severity, isNew: true, blocking: severity === 'error', path: mapPath, message: 'carte de l\'architecture supprimée par le changement : la rétablir (apv structure map).' });
        }
        for (const i of undescribed) {
            const isNew = !baseKeys.has(i.key);
            out.push({ code: 'architecture-map', severity: isNew ? severity : 'warning', isNew, blocking: isNew && severity === 'error', path: mapPath,
                message: `${label[i.kind]} ${i.key} ${added[i.kind][isNew ? 0 : 1]} sans rôle dans la carte de l'architecture${mapText === null ? ' (carte absente : apv structure map)' : ''} : écrire « - \`${i.key}\` : <rôle en une ligne> » dans le bloc « Rôles »${i.known ? ` (rôle connu de la pile : ${i.known.role})` : ''}.` });
        }
        if (mapText !== null) {
            const baseSet = new Set(baseFiles);
            const baseDirs = new Set(baseFiles.flatMap(f => { const d = []; for (let x = posix.dirname(f); x !== '.'; x = posix.dirname(x))
                d.push(x); return d; }));
            const brokenAtBase = new Set(baseMap === null ? [] : brokenLinks(baseMap, baseMapPath, p => baseSet.has(p) || baseDirs.has(p)).map(b => b.target));
            for (const b of brokenLinks(mapText, mapPath, p => existsSync(join(repo, p)))) {
                const isNew = !brokenAtBase.has(b.target);
                out.push({ code: 'architecture-map', severity: isNew ? severity : 'warning', isNew, blocking: isNew && severity === 'error', path: `${mapPath}:${b.line}`, message: `lien cassé : ${b.target}${isNew ? ' (cassé par le changement)' : ''} ; corriger la cible ou retirer le lien.` });
            }
        }
    }
    out.sort((a, b) => Number(b.blocking) - Number(a.blocking) || byText(a.code, b.code) || byText(a.path, b.path) || byText(a.message, b.message));
    const blocked = out.some(f => f.blocking) || report.findings.some(f => f.blocking);
    return {
        ...report,
        ok: !blocked,
        base: changes?.base ?? { source: 'none', ref: null, mergeBase: null },
        changes: out,
        architectureMap: { path: mapPath, exists: mapText !== null, profile: profile.id, items: items.length, described: items.length - items.filter(i => roleOf(i, roles) === null).length },
        usageError,
    };
}
/** A file at a commit, or null. */
function gitShow(repo, commit, path) {
    try {
        return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--no-pager', 'show', '--no-textconv', '--end-of-options', `${commit}:${path}`], {
            cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024, timeout: 30_000,
            env: { ...environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG']), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
        });
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=check.js.map
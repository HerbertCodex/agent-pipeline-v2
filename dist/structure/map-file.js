import { existsSync, readFileSync } from 'node:fs';
import { mapPath, writeAtomically } from '../commands/map.js';
import { newMap, refreshMap } from './archmap.js';
import { mapInputs } from './check.js';
import { structureSettings } from './config.js';
/**
 * Writes or checks the architecture map (docs/STRUCTURE.md, « Carte de l'architecture »): its generated parts are
 * rewritten, its written parts never. With `create`, a missing map is written with its generated parts filled and its
 * written parts as drafts. With `check`, nothing is written: a map whose generated parts no longer match is stale.
 */
export async function architectureMap(repo, config, options) {
    const settings = structureSettings(config.structure);
    const file = settings.architectureMap;
    const full = mapPath(repo, file);
    const actual = existsSync(full) ? readFileSync(full, 'utf8') : null;
    if (actual === null && !options.create)
        return { file, status: options.check && options.current === undefined ? 'missing' : 'absent', difference: null };
    const current = options.current ?? await (await import('../commands/map.js')).currentMap(repo, config);
    const inputs = mapInputs(repo, config, settings, current.files, current.tree);
    if (actual === null) {
        if (options.check)
            return { file, status: 'missing', difference: null };
        writeAtomically(repo, file, newMap(inputs));
        return { file, status: 'created', difference: null };
    }
    const expected = refreshMap(actual, inputs);
    if (options.check) {
        if (expected === actual)
            return { file, status: 'up-to-date', difference: null };
        const a = new Set(actual.split('\n'));
        const e = new Set(expected.split('\n'));
        return { file, status: 'stale', difference: { onlyInFile: [...a].filter(l => l && !e.has(l)).slice(0, 10), onlyExpected: [...e].filter(l => l && !a.has(l)).slice(0, 10) } };
    }
    if (expected === actual)
        return { file, status: 'unchanged', difference: null };
    writeAtomically(repo, file, expected);
    return { file, status: 'written', difference: null };
}
//# sourceMappingURL=map-file.js.map
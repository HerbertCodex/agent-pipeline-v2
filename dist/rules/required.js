/**
 * Checks every web project must declare, mandatory, before a merge (rule `controles`): the reuse of the shared components,
 * the code map and the tree structure. A check is recognised by the start of its command (`apv reuse check ...`), wrapped
 * or not (`node .../cli.js reuse check`, `npx apv ...`), whatever its id and its options (`--base {{baseSha}}`). The
 * architecture map is checked by `apv structure check` itself (its rule `architecture-map`): the `structure` check covers
 * it. A new capability of the tool that has its own check is added here; a project adds its own through `rules.requiredGates`.
 */
export const REQUIRED_WEB_GATES = [
    { id: 'reuse', command: ['apv', 'reuse', 'check'], source: 'apv' },
    { id: 'code-map', command: ['apv', 'map', '--check'], source: 'apv' },
    { id: 'structure', command: ['apv', 'structure', 'check'], source: 'apv' },
];
const LAUNCHERS = new Set(['node', 'npx', 'bunx', 'pnpm', 'yarn', 'exec', 'dlx']);
const isTool = (w) => w === 'apv' || /(?:^|\/)dist\/cli\.js$/.test(w) || /(?:^|\/)bin\/apv$/.test(w);
/**
 * The words of a command after its launcher: `node <plugin>/dist/cli.js reuse check` and `npx apv reuse check` read as
 * `apv reuse check`. Only launchers (and their options) may come before the tool: `echo apv reuse check` is not the tool.
 */
function normalized(command) {
    const words = [...command];
    const cli = words.findIndex(isTool);
    if (cli < 0 || !words.slice(0, cli).every(w => LAUNCHERS.has(w.slice(w.lastIndexOf('/') + 1)) || w.startsWith('-')))
        return words;
    return ['apv', ...words.slice(cli + 1)];
}
/** Whether `command` runs `required` (its words, in order, at the start of the command once the launcher is read). */
export function runsCommand(command, required) {
    const words = normalized(command);
    if (required[0] === 'apv')
        return words[0] === 'apv' && required.every((w, i) => words[i] === w);
    // A project command: its words anywhere, in order and contiguous (`npm run check:a11y`, wrapped in `apv lock run`).
    for (let i = 0; i + required.length <= words.length; i += 1)
        if (required.every((w, k) => words[i + k] === w))
            return true;
    return false;
}
/** The required checks the configuration lacks, or declares without `mandatory`. */
export function missingRequiredGates(config, required) {
    const out = [];
    for (const r of required) {
        const found = config.gates.filter(g => runsCommand(g.command, r.command));
        if (!found.length)
            out.push({ id: r.id, command: [...r.command], problem: 'absent' });
        else if (!found.some(g => g.mandatory))
            out.push({ id: r.id, command: [...r.command], problem: 'optional' });
    }
    return out;
}
//# sourceMappingURL=required.js.map
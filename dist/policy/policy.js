import { invariant } from '../domain/errors.js';
export function validRelativePath(path) {
    return path.length > 0 && !path.startsWith('/') && !/^[a-zA-Z]:/.test(path) &&
        !path.includes('\\') && !/[\0\r\n]/.test(path) &&
        path.split('/').every(p => p !== '' && p !== '.' && p !== '..');
}
// Restricted portable globs: *, **, ?. Brackets and parentheses are literal path characters (dynamic
// route or group directories in several stacks); character classes are not supported. Braces and a
// leading "!" are refused so that brace expansion or negation never silently matches nothing.
export function matches(path, pattern) {
    invariant(validRelativePath(pattern) && !/[{}]/.test(pattern) && !pattern.split('/').some(segment => segment.startsWith('!')), 'GLOB', `Unsupported glob: ${pattern}. Use only *, ** and ?; brackets and parentheses are literal characters, braces and leading ! are not supported.`);
    let regex = '^';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*' && pattern[i + 1] === '*') {
            i++;
            if (pattern[i + 1] === '/') {
                regex += '(?:.*/)?';
                i++;
            }
            else
                regex += '.*';
        }
        else if (c === '*')
            regex += '[^/]*';
        else if (c === '?')
            regex += '[^/]';
        else
            regex += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`${regex}$`).test(path);
}
export const sensitivePaths = [
    '.agent-pipeline/**', '.github/**', '.gitmodules', '.gitattributes', '**/AGENTS.md', '**/CLAUDE.md', '.codex/**', '.claude/**', '.agents/**', '**/SKILL.md', 'roles/**', 'skills/**',
    '**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/pnpm-lock.yaml', '**/yarn.lock',
    '**/requirements*.txt', '**/pyproject.toml', '**/uv.lock', '**/poetry.lock',
    '**/Cargo.toml', '**/Cargo.lock', '**/go.mod', '**/go.sum',
    '**/*.sql', '**/migrations/**', '**/auth/**', '**/*auth*.*', '**/security/**',
    '**/payment*/**', '**/*permission*.*', '**/*policy*.*', '**/*secret*.*',
    '**/Dockerfile*', '**/*.tf', '**/.env*', '**/pipeline*.json',
];
export function classify(changes, config, minimum = 'fast') {
    const sensitive = changes.files.filter(f => [...sensitivePaths, ...config.risk.highPaths].some(p => matches(f, p)));
    if (minimum === 'high' || sensitive.length || changes.binary)
        return { lane: 'high', reasons: [
                ...(minimum === 'high' ? ['Requested minimum: high'] : []),
                ...sensitive.map(f => `Sensitive path: ${f}`), ...(changes.binary ? ['Binary change'] : []),
            ] };
    if (minimum !== 'standard' && changes.files.length > 0 && changes.files.length <= config.risk.maxFastFiles &&
        changes.lines <= config.risk.maxFastLines && changes.files.every(f => config.risk.fastPaths.some(p => matches(f, p)))) {
        return { lane: 'fast', reasons: ['All observed paths are in the approved fast set; size limits satisfied'] };
    }
    return { lane: 'standard', reasons: ['Default assurance for code, unknown impact, or size threshold'] };
}
/** Every scope violation of a change, for a report; `assertScope` turns it into the V2 error. */
export function scopeReport(changes, task) {
    const allowedNewPaths = task.allowedNewPaths ?? [];
    for (const p of [...task.allowedPaths, ...allowedNewPaths])
        matches('probe', p);
    const files = Array.isArray(changes) ? changes : changes.files;
    const added = new Set(Array.isArray(changes) ? [] : changes.added);
    const autoNew = [];
    const rejected = [];
    for (const file of files) {
        if (!validRelativePath(file)) {
            rejected.push(file);
            continue;
        }
        if (task.allowedPaths.some(p => matches(file, p)))
            continue;
        const safeNew = added.has(file) && allowedNewPaths.some(p => matches(file, p)) &&
            !sensitivePaths.some(p => matches(file, p));
        if (safeNew) {
            autoNew.push(file);
            continue;
        }
        rejected.push(file);
    }
    return { autoNew, rejected, tooManyNew: autoNew.length > (task.maxNewFiles ?? 0) };
}
export function assertScope(changes, task) {
    const { autoNew, rejected, tooManyNew } = scopeReport(changes, task);
    invariant(!tooManyNew, 'SCOPE', `Too many automatically-created supporting files: ${autoNew.join(', ')}`);
    invariant(rejected.length === 0, 'SCOPE', `Out-of-scope files: ${rejected.join(', ')}`);
    return autoNew;
}
export function validateDag(gates) {
    const byId = new Map(gates.map(g => [g.id, g]));
    invariant(byId.size === gates.length, 'DAG', 'Duplicate gate id');
    const visiting = new Set();
    const done = new Set();
    function visit(id) {
        if (done.has(id))
            return;
        invariant(!visiting.has(id), 'DAG', `Dependency cycle at ${id}`);
        const gate = byId.get(id);
        invariant(gate, 'DAG', `Missing gate ${id}`);
        visiting.add(id);
        gate.dependsOn.forEach(visit);
        visiting.delete(id);
        done.add(id);
    }
    gates.forEach(g => visit(g.id));
}
export function planGates(config, changes, lane) {
    validateDag(config.gates);
    const requirements = validationRequirements(config, changes.files, lane);
    const chosen = new Set(config.gates.filter(g => lane === 'high' || g.mandatory ||
        (gateApplies(g, changes.files) && g.lanes.includes(lane))).map(g => g.id));
    for (const requirement of requirements) {
        const applicable = config.gates.filter(g => gateApplies(g, requirement.paths ?? changes.files));
        if (requirement.anyOf.length === 1) {
            applicable.filter(g => g.covers.includes(requirement.anyOf[0])).forEach(g => chosen.add(g.id));
        }
        else if (!applicable.some(g => chosen.has(g.id) && g.covers.some(k => requirement.anyOf.includes(k)))) {
            // Prefer unit tests for a local edit; a behavioral obligation must not force every browser suite.
            const gate = requirement.anyOf.flatMap(k => applicable.filter(g => g.covers.includes(k)))[0];
            if (gate)
                chosen.add(gate.id);
        }
    }
    const byId = new Map(config.gates.map(g => [g.id, g]));
    function include(id) { for (const dep of byId.get(id).dependsOn) {
        if (!chosen.has(dep)) {
            chosen.add(dep);
            include(dep);
        }
    } }
    [...chosen].forEach(include);
    invariant(chosen.size > 0, 'NO_GATES', `No checks configured for ${lane}; refusing empty validation`);
    return config.gates.filter(g => chosen.has(g.id));
}
export function gateApplies(gate, files) {
    return gate.paths.length === 0 || files.some(f => gate.paths.some(p => matches(f, p)));
}
export function isCodeChange(files) {
    return !files.length || files.some(p => !/\.(?:md|rst|txt)$/i.test(p) || /(?:^|\/)requirements[^/]*\.txt$/i.test(p));
}
function isTestFile(path) {
    return /(?:^|\/)(?:test|tests|__tests__|e2e)\/|\.(?:test|spec)\.[^/]+$|_test\.go$/i.test(path);
}
export function isUiChange(files) {
    return files.some(p => !isTestFile(p) && (/\.(?:html|css|scss|sass|less|tsx|jsx|vue|svelte|mdx)$/i.test(p) ||
        /(?:^|\/)(?:ui|components|pages|views|frontend)\/.*\.(?:[cm]?[jt]s)$/i.test(p)));
}
/** Conservative defaults plus reviewed project paths, not a semantic classifier. */
export function validationRequirements(config, files, lane) {
    if (config.workflow.qualityReview !== 'evidence')
        return [];
    const required = [];
    const add = (id, anyOf, reason, paths) => required.push({ id, anyOf, reason, ...(paths ? { paths } : {}) });
    const code = isCodeChange(files);
    const productionFiles = files.filter(p => !isTestFile(p) && isCodeChange([p]));
    const production = code && (!files.length || productionFiles.some(p => isCodeChange([p])));
    if (code)
        add('behavior', ['unit', 'integration', 'browser'], 'Executable changes need behavioral tests.');
    if (production && (config.gates.some(g => g.covers.includes('build') && gateApplies(g, files)) ||
        productionFiles.some(p => /\.(?:tsx?|jsx|vue|svelte|mdx|rs|go|java|kt|cs|c|cpp)$/i.test(p) || /(?:^|\/)(?:package\.json|Cargo\.toml|go\.mod|pom\.xml)$/.test(p))))
        add('build', ['build'], 'Changed build inputs or an existing applicable production build.', productionFiles);
    if (production && (lane === 'high' || productionFiles.some(p => /(?:^|\/)(?:api|routes|adapters|repositories|migrations|database|db|integrations)(?:\/|\.)|\.sql$/i.test(p))))
        add('integration', ['integration'], 'Changed integration boundary or high-risk executable change.', lane === 'high' ? productionFiles : productionFiles.filter(p => /(?:^|\/)(?:api|routes|adapters|repositories|migrations|database|db|integrations)(?:\/|\.)|\.sql$/i.test(p)));
    if (isUiChange(files))
        add('browser', ['browser'], 'Changed UI source needs an observed browser check.', files.filter(p => isUiChange([p])));
    for (const rule of config.validationRules ?? []) {
        // Validate patterns even when no changed file would match (misconfiguration must be visible).
        rule.paths.forEach(p => matches('probe', p));
        if (files.some(f => rule.paths.some(p => matches(f, p))))
            for (const kind of rule.requires)
                add(`rule:${rule.id}:${kind}`, [kind], `Project validation rule: ${rule.id}`, files.filter(f => rule.paths.some(p => matches(f, p))));
    }
    return required;
}
export function requiredApprovals(lane, mode = 'team') {
    if (mode === 'solo')
        return lane === 'fast' ? 0 : 1;
    if (mode === 'regulated')
        return lane === 'high' ? 2 : 1;
    return lane === 'high' ? 2 : lane === 'standard' ? 1 : 0;
}
//# sourceMappingURL=policy.js.map
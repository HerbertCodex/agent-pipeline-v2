/** Maximum characters of a failed gate diagnostic kept in a receipt and handed to a repair. */
export const MAX_DIAGNOSTIC_CHARS = 16000;
// Vocabulary shared by test runners, compilers and linters across ecosystems. It selects lines to
// keep; it never decides whether a gate passed (the exit status does).
const FAILURE = /(\bfail(?:ed|ure|ures|ing|s)?\b|\berrors?\b|\bexceptions?\b|\bassert(?:ion)?(?:error)?\b|\bexpected\b|\breceived\b|\bactual\b|\bpanic(?:ked)?\b|\btraceback\b|^\s*not ok\b|[✗×✖❌]|\bundefined reference\b|\bcannot find\b|\bunresolved\b|\bmismatch\b)/i;
const CONTEXT_BEFORE = 2;
const CONTEXT_AFTER = 6;
/**
 * Failure-focused excerpt of a failed command: the beginning of the output, every line matching generic
 * failure vocabulary with surrounding context, and the end (usually the summary). A plain tail used to
 * keep only passing-test noise and the summary, hiding which tests failed and why.
 */
export function failureExcerpt(status, stderr, stdout, limit = MAX_DIAGNOSTIC_CHARS) {
    const text = `${status}\n${stderr}\n${stdout}`;
    if (text.length <= limit)
        return text;
    const lines = text.split('\n');
    const head = lines.slice(0, 15).join('\n').slice(0, Math.floor(limit * 0.1));
    const tail = lines.slice(-25).join('\n').slice(-Math.floor(limit * 0.2));
    const keep = new Set();
    lines.forEach((line, i) => {
        if (!FAILURE.test(line))
            return;
        for (let j = Math.max(0, i - CONTEXT_BEFORE); j <= Math.min(lines.length - 1, i + CONTEXT_AFTER); j++)
            keep.add(j);
    });
    const budget = limit - head.length - tail.length - 200;
    const blocks = [];
    let used = 0;
    let previous = -2;
    let omitted = 0;
    for (const i of [...keep].sort((a, b) => a - b)) {
        const line = lines[i].length > 1000 ? `${lines[i].slice(0, 1000)}…` : lines[i];
        if (used + line.length + 1 > budget) {
            omitted++;
            continue;
        }
        if (i !== previous + 1)
            blocks.push(`… [line ${i + 1}]`);
        blocks.push(line);
        used += line.length + 1;
        previous = i;
    }
    const truncatedNote = omitted ? `\n… [${omitted} more failure-context lines omitted]` : '';
    return `${head}\n… [failure-focused excerpt of ${text.length} characters]\n${blocks.join('\n')}${truncatedNote}\n… [end of output]\n${tail}`.slice(0, limit);
}
//# sourceMappingURL=diagnostic.js.map
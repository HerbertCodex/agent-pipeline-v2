/**
 * Risk level of a diff (`apv review plan`, `apv gates run --since`). Pilot project, 3 October 2026: a pull request of
 * tests and interface texts went through four reviews, a loop of corrections and two full suites of 30 minutes. The
 * level says whether a change only touches what cannot change the behavior of the product on its own:
 * - `faible`: tests and test tooling, documentation, interface texts without new markup (or a file that no class
 *   describes whose changed lines are only prose strings), mockups;
 * - `eleve`: everything else (migration, schema, data, personal data, export, tracker, legal text, sensitive path of
 *   the high lane such as authentication, session, permissions or security configuration, server code or configuration,
 *   new markup or code, a file moved, a term of data or GDPR in the changed lines, a file no class describes): the
 *   review plan then behaves exactly as before the level existed.
 * The level never removes the security review, which every plan keeps.
 */

/** Markup languages: a text node between tags is prose. */
const MARKUP = /\.(?:svelte|vue|astro|html?|jsx|tsx|hbs|handlebars|ejs|njk|liquid|erb|twig|jinja2?|mdx)$/;

/** Placeholders of a skeleton: a string literal, a text node. */
const S = '\u0001S\u0001';
const T = '\u0001T\u0001';

/**
 * A line reduced to its structure: string literals and text nodes replaced, whitespace dropped; the string literals
 * (attribute values included) and the text nodes taken out apart.
 */
interface Skeleton { shape: string; literals: string[]; nodes: string[]; contexts: string[] }

const isCommentLine = (code: string): boolean => /^(?:\/\/|\/\*|\*|#(?!\{)|<!--|-->)/.test(code);
/** Looks like code in a line of a markup file without tags: an assignment, a call, an arrow, a statement keyword. */
const CODE_LIKE = /[=;{}<>`$\\]|[\w$\]]\s*\(|\b(?:import|export|const|let|var|function|return|await|async|class|new|if|else|for|while|throw|typeof|delete)\b/;

/**
 * The structure of one changed line. String literals (`'…'`, `"…"`, a template without `${`) become `S`; in a markup
 * file, the text between two tags (and before the first or after the last tag) becomes `T`, and a line with no tag and
 * nothing that looks like code is a text node. A comment line counts as prose. Null: a line that cannot be read
 * safely (a string left open, a template with an expression).
 */
export function skeleton(line: string, markup: boolean): Skeleton | null {
  const code = line.trim();
  if (!code || isCommentLine(code)) return { shape: '', literals: [], nodes: [], contexts: [] };
  const literals: string[] = [];
  const contexts: string[] = [];
  const nodes: string[] = [];
  let out = '';
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1; let body = '';
      for (; j < code.length && code[j] !== c; j++) {
        if (code[j] === '\\') { body += code[j]! + (code[j + 1] ?? ''); j++; continue; }
        if (c === '`' && code[j] === '$' && code[j + 1] === '{') return null;
        body += code[j];
      }
      // An apostrophe inside a text node of markup (`l'écran`) is not a quote: the line is read as text below.
      if (j >= code.length) { if (markup) { out += code.slice(i); break; } return null; }
      literals.push(body); contexts.push(out.slice(-40)); out += S; i = j; continue;
    }
    out += c;
  }
  if (markup) {
    if (!/[<>]/.test(out)) {
      // A text node with an apostrophe was cut as a string above: the whole line is the node.
      if (!CODE_LIKE.test(code.replace(/['"]/g, ''))) return { shape: T, literals: [], nodes: [code], contexts: [] };
    } else {
      out = out.replace(/>([^<>{}]+)</g, (_m, text: string) => { if (text.trim()) nodes.push(text.trim()); return `>${T}<`; })
        .replace(/^([^<>{}]+)</, (_m, text: string) => { nodes.push(text.trim()); return `${T}<`; })
        .replace(/>([^<>{}]+)$/, (_m, text: string) => { nodes.push(text.trim()); return `>${T}`; });
    }
  }
  return { shape: out.replace(/\s+/g, ''), literals, nodes, contexts };
}

/** A line that only carries prose: a text node, a string (in a list or a concatenation), a property whose value is a string. */
const TEXT_SHAPE = new RegExp(`^(?:${T}|${S}[,+]?|\\+?${S}[,;]?|(?:[\\w$]+|${S}):${S}[,;]?)$`);
export const isTextShape = (shape: string): boolean => shape === '' || TEXT_SHAPE.test(shape);
/** A plain declaration of a string: `const title = '…';`, `export let label = '…'` (whitespace dropped). */
const DECLARATION = new RegExp(`^(?:export)?(?:const|let|var)[\\w$]+=${S};?$`);
/** Attributes whose value is shown or read out, never acted on. */
const TEXT_ATTRIBUTE = /(?:^|[\s{(])(?:alt|title|placeholder|aria-label|aria-description|aria-placeholder|label)\s*=\s*\{?\s*$/;

/**
 * Whether a changed string of the line may count as text: the line only carries prose, declares a string, or the
 * string is the value of a text attribute. Anywhere else (a comparison, a call, an address, a route, a class), the
 * string is part of the structure: it must be the same before and after.
 */
function freeLiterals(s: Skeleton): boolean {
  return isTextShape(s.shape) || DECLARATION.test(s.shape) || (s.contexts.length > 0 && s.contexts.every(c => TEXT_ATTRIBUTE.test(c)));
}
/** The key a line is compared by: its structure, with its strings when they are part of it. */
const key = (s: Skeleton): string => freeLiterals(s) ? s.shape : `${s.shape}\u0002${s.literals.join('\u0002')}`;

/**
 * Prose, not a value the code acts on: a space and a letter, and nothing of an address, a markup, an expression or a
 * path (`role: 'admin'`, a URL, a CSS selector or a header value stay code). A one-word label is not prose: the file
 * keeps its review.
 */
export function isProse(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return /\s/.test(t) && /\p{L}/u.test(t) && !/:\/\/|[<>{}`]|\$\{|^\.{0,2}\/|^[\w-]+=/.test(t);
}

/**
 * True when the changed lines of a file only change prose: interface texts, strings of a messages module, comments.
 * The removed and added lines, reduced to their structure, are the same multiset once the lines that only carry prose
 * are set aside; every changed string literal (attribute values included) reads as prose. A new tag, attribute, expression,
 * call or any other code is a change of structure. A file added or deleted whole has a structure that changes.
 */
export function textOnly(patch: { binary: boolean; removed: string[]; added: string[] }, path: string): boolean {
  if (patch.binary) return false;
  if (!patch.removed.some(l => l.trim()) && !patch.added.some(l => l.trim())) return false;
  const markup = MARKUP.test(path);
  const removed: Skeleton[] = [];
  const added: Skeleton[] = [];
  for (const [lines, into] of [[patch.removed, removed], [patch.added, added]] as const) {
    for (const line of lines) {
      const s = skeleton(line, markup);
      if (!s) return false;
      into.push(s);
    }
  }
  const pool = new Map<string, number>();
  for (const r of removed) if (!isTextShape(r.shape)) pool.set(key(r), (pool.get(key(r)) ?? 0) + 1);
  for (const a of added) {
    if (isTextShape(a.shape)) continue;
    const left = pool.get(key(a)) ?? 0;
    if (!left) return false;
    pool.set(key(a), left - 1);
  }
  if ([...pool.values()].some(n => n > 0)) return false;
  // A free string reads like a word, an address or a path when the code acts on it: it counts as text only when it is
  // prose. Text nodes are prose.
  const before = removed.filter(freeLiterals).flatMap(r => r.literals);
  const after = added.filter(freeLiterals).flatMap(a => a.literals);
  return after.filter(t => !before.includes(t)).every(isProse) && before.filter(t => !after.includes(t)).every(isProse);
}

/** Risk level of a diff. */
export type RiskLevel = 'faible' | 'eleve';
export const RISK_LEVELS: readonly RiskLevel[] = ['faible', 'eleve'];
export const RISK_LABEL: Readonly<Record<RiskLevel, string>> = { faible: 'faible', eleve: 'élevé' };

export interface DiffRisk {
  level: RiskLevel;
  /** One sentence: what makes the level, with the number of files of each reason. */
  reason: string;
  /** Files of a high risk, with their reason (50 at most), and how many in all. */
  files: { path: string; why: string }[];
  fileCount: number;
}

/** The level of a diff from the risk of each of its files: high as soon as one file is. */
export function diffRisk(files: readonly { path: string; risk: RiskLevel; riskWhy: string }[], shown = 50): DiffRisk {
  const high = files.filter(f => f.risk === 'eleve');
  const tally = (list: readonly { riskWhy: string }[]): string => {
    const whys = new Map<string, number>();
    for (const f of list) whys.set(f.riskWhy, (whys.get(f.riskWhy) ?? 0) + 1);
    return [...whys].map(([why, n]) => `${why} (${n})`).join(' ; ');
  };
  if (!files.length) return { level: 'faible', reason: 'diff vide', files: [], fileCount: 0 };
  if (!high.length) return { level: 'faible', reason: `seulement ${tally(files)}`, files: [], fileCount: 0 };
  return { level: 'eleve', reason: tally(high), files: high.slice(0, shown).map(f => ({ path: f.path, why: f.riskWhy })), fileCount: high.length };
}

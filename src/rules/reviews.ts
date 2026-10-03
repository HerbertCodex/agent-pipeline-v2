import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { PipelineError, invariant } from '../domain/errors.js';
import { REVIEW_DOMAINS, type ReviewDomainName } from '../review/config.js';
import { gitRead, resolveCommit } from '../run/git-probe.js';
import { CAPTURE_THEMES, CAPTURE_VIEWPORTS, type CaptureTheme, type CaptureViewport } from './config.js';
import { anchorKey, sign, signatureValid } from './operator.js';

/**
 * Review records: what a reviewer agent found at one exact commit, kept in the Git common directory
 * (`<git common dir>/apv/reviews/<commit>/<domaine>/`), outside every worktree and never versioned, with a copy of its
 * report and of its captures under their sha256. `apv review record` writes them; the Bash guard of the plugin lets only
 * the reviewer agent of the domain run it (`apv:qa-securite` for securite...), never the implementer, the integrator nor
 * the lead, and refuses the commands and the writes that name this folder. `apv rules check` reads them before a merge.
 */
export const REVIEWS_DIR = ['apv', 'reviews'] as const;

/** The reviewer agent of each domain of `apv review plan`: the only one whose record counts. */
export const DOMAIN_REVIEWERS: Readonly<Record<ReviewDomainName, string>> = {
  securite: 'qa-securite',
  fidelite: 'qa-fidelite',
  donnees: 'architecte-donnees',
  rgpd: 'dpo',
};

/** `apv:qa-securite` and `qa-securite` name the same agent. */
export const agentName = (value: string): string => value.trim().replace(/^apv:/, '');

export interface Findings { critical: number; high: number; medium: number; low: number }
export interface StoredFile { file: string; sha256: string; bytes: number }
export interface StoredCapture extends StoredFile { viewport: CaptureViewport; theme: CaptureTheme }
export interface ReviewRecord {
  version: 1;
  id: string;
  commit: string;
  domain: ReviewDomainName;
  reviewer: string;
  at: string;
  findings: Findings;
  report: StoredFile;
  captures: StoredCapture[];
}

export interface CaptureInput { viewport: CaptureViewport; theme: CaptureTheme; path: string }
export interface RecordInput {
  /** The checkout the reviewer read: its HEAD must be the commit, its tracked files unchanged. */
  checkout: string;
  commit: string;
  domain: string;
  reviewer: string;
  findings: Findings;
  report: string;
  captures: CaptureInput[];
  now?: Date;
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
/** Smallest capture accepted, in bytes: an empty or placeholder image proves nothing. */
export const MIN_CAPTURE_BYTES = 1024;
/** Smallest report accepted, in bytes. */
export const MIN_REPORT_BYTES = 200;
/** How many characters of the commit the report must cite. */
export const REPORT_SHA = 12;

/** The image format of a capture from its first bytes (PNG, JPEG, WebP), or null. */
export function imageFormat(data: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export function reviewsDir(common: string, commit: string): string {
  return join(common, ...REVIEWS_DIR, commit);
}

/** Parses `desktop:dark:chemin.png` (`--capture`). */
export function parseCapture(value: string): CaptureInput {
  const m = /^([a-z]+):([a-z]+):(.+)$/.exec(value);
  if (!m || !(CAPTURE_VIEWPORTS as readonly string[]).includes(m[1]!) || !(CAPTURE_THEMES as readonly string[]).includes(m[2]!)) {
    throw new PipelineError('REVIEW_RECORD', `--capture ${value} : format <largeur>:<thème>:<fichier>, largeur ${CAPTURE_VIEWPORTS.join(', ')}, thème ${CAPTURE_THEMES.join(', ')} (ex. phone:dark:captures/liste-sombre.png)`);
  }
  return { viewport: m[1] as CaptureViewport, theme: m[2] as CaptureTheme, path: m[3]! };
}

/**
 * Records a review at the exact commit the checkout holds. Refused when the checkout is elsewhere or modified, the
 * reviewer is not the agent of the domain, the report is too short or does not cite the commit, a capture is not an image
 * or the same image stands for two captures (several screens: several captures per width and theme, each its own image). The record is written even with critical or high findings: it is what the
 * reviewer saw, and `apv rules check` refuses the merge on it.
 */
export function recordReview(common: string, input: RecordInput): ReviewRecord {
  const domain = input.domain as ReviewDomainName;
  invariant((REVIEW_DOMAINS as readonly string[]).includes(domain), 'REVIEW_RECORD', `domaine inconnu ${input.domain} (${REVIEW_DOMAINS.join(', ')})`);
  const reviewer = agentName(input.reviewer);
  invariant(reviewer === DOMAIN_REVIEWERS[domain], 'REVIEW_RECORD',
    `la relecture ${domain} s'enregistre par l'agent ${DOMAIN_REVIEWERS[domain]} (apv:${DOMAIN_REVIEWERS[domain]}), pas par ${reviewer || 'un inconnu'}`);
  const commit = resolveCommit(input.checkout, input.commit);
  if (!commit) throw new PipelineError('REVIEW_RECORD', `commit introuvable : ${input.commit}`);
  const head = resolveCommit(input.checkout, 'HEAD');
  invariant(head === commit, 'REVIEW_RECORD', `la copie relue est à ${head?.slice(0, 12) ?? '?'}, pas à ${commit.slice(0, 12)} : relire depuis une copie détachée au commit exact (git worktree add --detach <dossier> ${commit.slice(0, 12)})`);
  const status = gitRead(input.checkout, ['status', '--porcelain=v1', '--untracked-files=no']);
  invariant(status === '', 'REVIEW_RECORD', status === null ? 'état de la copie illisible (git status)' : 'la copie relue a des fichiers suivis modifiés : la relecture ne porterait pas sur le commit');
  for (const [k, v] of Object.entries(input.findings)) invariant(Number.isInteger(v) && v >= 0 && v <= 10_000, 'REVIEW_RECORD', `--${k} : entier de 0 à 10000 attendu`);
  let report: Buffer;
  try { report = readFileSync(input.report); } catch (error) { throw new PipelineError('REVIEW_RECORD', `rapport illisible (${input.report}) : ${(error as Error).message}`); }
  invariant(report.length >= MIN_REPORT_BYTES, 'REVIEW_RECORD', `rapport trop court (${report.length} octets, ${MIN_REPORT_BYTES} au moins) : le rapport complet de la relecture, avec ses constats`);
  invariant(report.toString('utf8').includes(commit.slice(0, REPORT_SHA)), 'REVIEW_RECORD', `le rapport ne cite pas le commit relu (${commit.slice(0, REPORT_SHA)}) : il doit le nommer`);
  const images: { input: CaptureInput; data: Buffer; format: string }[] = [];
  for (const c of input.captures) {
    let data: Buffer;
    try { data = readFileSync(c.path); } catch (error) { throw new PipelineError('REVIEW_RECORD', `capture illisible (${c.path}) : ${(error as Error).message}`); }
    const format = imageFormat(data);
    invariant(format !== null, 'REVIEW_RECORD', `capture ${c.path} : ni PNG, ni JPEG, ni WebP`);
    invariant(data.length >= MIN_CAPTURE_BYTES, 'REVIEW_RECORD', `capture ${c.path} : ${data.length} octets, image vide ou factice`);
    images.push({ input: c, data, format });
  }
  // Several screens: several captures per width and theme, never the same image twice.
  const hashes = new Map<string, string>();
  for (const img of images) {
    const pair = `${img.input.viewport}:${img.input.theme}`;
    const digest = sha256(img.data);
    const twin = hashes.get(digest);
    invariant(!twin, 'REVIEW_RECORD', `la même image sert pour ${twin} et ${pair} : une capture distincte par écran, largeur et thème`);
    hashes.set(digest, pair);
  }
  const now = input.now ?? new Date();
  const id = `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomUUID().slice(0, 8)}`;
  const dir = join(reviewsDir(common, commit), domain);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const reportFile = `${id}-rapport${extname(input.report).slice(0, 10) || '.md'}`;
  writeFileSync(join(dir, reportFile), report, { mode: 0o600, flag: 'wx' });
  const captures: StoredCapture[] = images.map((img, k) => {
    const file = `${id}-${img.input.viewport}-${img.input.theme}-${k + 1}.${img.format}`;
    copyFileSync(img.input.path, join(dir, file));
    return { viewport: img.input.viewport, theme: img.input.theme, file, sha256: sha256(img.data), bytes: img.data.length };
  });
  const record: ReviewRecord = { version: 1, id, commit, domain, reviewer: `apv:${reviewer}`, at: now.toISOString(), findings: { ...input.findings },
    report: { file: reportFile, sha256: sha256(report), bytes: report.length }, captures };
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return record;
}

/** The seal of a record: HMAC of its file with the anchor key, written by the PostToolUse hook, never by the tool. */
const sealOf = (key: Buffer, content: Buffer): string => sign(key, 'review', sha256(content));

/** Whether the record `id` of `domain` is stored under this Git common directory, at any commit. */
export function recordExists(common: string, id: string, domain: string): boolean {
  if (!/^[\w-]+$/.test(id) || !/^[\w-]+$/.test(domain)) return false;
  const root = join(common, ...REVIEWS_DIR);
  try { return readdirSync(root).some(commit => existsSync(join(root, commit, domain, `${id}.json`))); } catch { return false; }
}

/**
 * Seals the record `id` of `domain` (PostToolUse hook, hooks/scripts/review-seal.mjs): only when the command that wrote it
 * was run by the reviewer agent of the domain, which the hook checked. The seal is what `apv rules check` trusts: the
 * tool, run by any agent, never holds a way to make one. Returns the sealed file, or why nothing was sealed.
 */
export function sealReview(common: string, id: string, domain: string, agent: string, key: Buffer): { file: string | null; problem: string | null } {
  if (!/^[\w-]+$/.test(id) || !(REVIEW_DOMAINS as readonly string[]).includes(domain)) return { file: null, problem: 'enregistrement ou domaine invalide' };
  if (agentName(agent) !== DOMAIN_REVIEWERS[domain as ReviewDomainName]) return { file: null, problem: `agent ${agent} : pas le relecteur du domaine ${domain}` };
  const root = join(common, ...REVIEWS_DIR);
  let commits: string[];
  try { commits = readdirSync(root); } catch { return { file: null, problem: 'aucune relecture enregistrée' }; }
  for (const commit of commits) {
    const file = join(root, commit, domain, `${id}.json`);
    if (!existsSync(file)) continue;
    const content = readFileSync(file);
    const record = parseRecord(JSON.parse(content.toString('utf8')) as unknown, commit, domain);
    if (!record || agentName(record.reviewer) !== agentName(agent)) return { file: null, problem: 'enregistrement illisible, ou écrit sous un autre nom' };
    const seal = join(root, commit, domain, `${id}.sig`);
    try { writeFileSync(seal, `${sealOf(key, content)}\n`, { mode: 0o600, flag: 'wx' }); }
    catch { return { file: null, problem: 'déjà scellé' }; }
    return { file: seal, problem: null };
  }
  return { file: null, problem: `enregistrement ${id} introuvable` };
}

export interface ReadRecord { record: ReviewRecord | null; file: string; problem: string | null }

function checkStored(dir: string, stored: StoredFile): string | null {
  const path = join(dir, stored.file);
  if (!/^[\w.-]+$/.test(stored.file) || !existsSync(path) || !statSync(path).isFile()) return `fichier ${stored.file} absent`;
  return sha256(readFileSync(path)) === stored.sha256 ? null : `fichier ${stored.file} modifié depuis l'enregistrement`;
}

function parseRecord(value: unknown, commit: string, domain: string): ReviewRecord | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as ReviewRecord;
  const count = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 0;
  if (r.version !== 1 || r.commit !== commit || r.domain !== domain || typeof r.reviewer !== 'string' || typeof r.at !== 'string' || typeof r.id !== 'string') return null;
  if (!r.findings || !count(r.findings.critical) || !count(r.findings.high) || !count(r.findings.medium) || !count(r.findings.low)) return null;
  if (!r.report || typeof r.report.file !== 'string' || typeof r.report.sha256 !== 'string' || !Array.isArray(r.captures)) return null;
  return r;
}

/**
 * The latest record of each domain at `commit` (by date of record), each checked: its report and captures as recorded.
 * A record that does not match (another commit, another domain, a reviewer that is not the agent of the domain, a file
 * changed) is returned with its problem: it proves nothing.
 */
export function latestReviews(common: string, commit: string, key = anchorKey(common).key): Map<ReviewDomainName, ReadRecord> {
  const out = new Map<ReviewDomainName, ReadRecord>();
  for (const domain of REVIEW_DOMAINS) {
    const dir = join(reviewsDir(common, commit), domain);
    let names: string[];
    try { names = readdirSync(dir).filter(n => /^[\w-]+\.json$/.test(n)).sort(); } catch { continue; }
    // Ids start with the date: the last one in order is the latest record.
    const name = names.at(-1);
    if (!name) continue;
    const file = join(dir, name);
    let record: ReviewRecord | null = null;
    try { record = parseRecord(JSON.parse(readFileSync(file, 'utf8')) as unknown, commit, domain); } catch { record = null; }
    if (!record) { out.set(domain, { record: null, file, problem: 'enregistrement illisible ou pour un autre commit' }); continue; }
    if (agentName(record.reviewer) !== DOMAIN_REVIEWERS[domain]) { out.set(domain, { record, file, problem: `relecteur ${record.reviewer}, pas apv:${DOMAIN_REVIEWERS[domain]}` }); continue; }
    let seal = '';
    try { seal = readFileSync(join(dir, `${record.id}.sig`), 'utf8').trim(); } catch { seal = ''; }
    if (!key || !signatureValid(key, 'review', sha256(readFileSync(file)), seal)) {
      out.set(domain, { record, file, problem: key ? 'relecture non scellée par le crochet du plugin (écrite hors de l\'agent relecteur, ou modifiée depuis)' : 'clé d\'ancrage absente : aucune relecture ne peut être vérifiée' });
      continue;
    }
    const problem = [record.report, ...record.captures].map(s => checkStored(dir, s)).find(p => p !== null) ?? null;
    out.set(domain, { record, file, problem });
  }
  return out;
}

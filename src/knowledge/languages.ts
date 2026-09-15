import { invariant } from '../domain/errors.js';
import { languageProfileSchema, type LanguageProfile } from '../domain/knowledge.js';
export { languageProfileSchema, type LanguageProfile };

const IDENT = '[A-Za-z_$][\\w$]*';
const ecmaPrefilter = '^(export[[:space:]]|(async[[:space:]]+)?function|(abstract[[:space:]]+)?class[[:space:]]|interface[[:space:]]|type[[:space:]]|const[[:space:]]|let[[:space:]]|var[[:space:]]|enum[[:space:]])';

export const builtinLanguages: LanguageProfile[] = [
  { id: 'ecmascript', extensions: ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'], prefilter: ecmaPrefilter, declarations: [
    { kind: 'function', pattern: `^(?<export>export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:async\\s+)?function\\*?\\s+(?<name>${IDENT})`, exported: 'marker' },
    { kind: 'class', pattern: `^(?<export>export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(?<name>${IDENT})`, exported: 'marker' },
    { kind: 'interface', pattern: `^(?<export>export\\s+)?(?:declare\\s+)?interface\\s+(?<name>${IDENT})`, exported: 'marker' },
    { kind: 'type', pattern: `^(?<export>export\\s+)?(?:declare\\s+)?type\\s+(?<name>${IDENT})\\s*[=<]`, exported: 'marker' },
    { kind: 'enum', pattern: `^(?<export>export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(?<name>${IDENT})`, exported: 'marker' },
    { kind: 'const', pattern: `^(?<export>export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+(?<name>${IDENT})\\s*[=:]`, exported: 'marker' },
  ] },
  { id: 'python', extensions: ['py'], prefilter: '^((async[[:space:]]+)?def|class)[[:space:]]', declarations: [
    { kind: 'function', pattern: '^(?:async\\s+)?def\\s+(?<name>[A-Za-z_]\\w*)', exported: 'not-underscore' },
    { kind: 'class', pattern: '^class\\s+(?<name>[A-Za-z_]\\w*)', exported: 'not-underscore' },
  ] },
  { id: 'go', extensions: ['go'], prefilter: '^(func|type)[[:space:]]', declarations: [
    { kind: 'method', pattern: '^func\\s+\\([^)]*\\)\\s*(?<name>[A-Za-z_]\\w*)', exported: 'capitalized' },
    { kind: 'function', pattern: '^func\\s+(?<name>[A-Za-z_]\\w*)', exported: 'capitalized' },
    { kind: 'type', pattern: '^type\\s+(?<name>[A-Za-z_]\\w*)', exported: 'capitalized' },
  ] },
  { id: 'rust', extensions: ['rs'], prefilter: '^(pub[[:space:](]|(async[[:space:]]+)?(unsafe[[:space:]]+)?fn[[:space:]]|struct[[:space:]]|enum[[:space:]]|trait[[:space:]]|type[[:space:]]|mod[[:space:]])', declarations: [
    { kind: 'function', pattern: '^(?<export>pub(?:\\([^)]*\\))?\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?fn\\s+(?<name>[A-Za-z_]\\w*)', exported: 'marker' },
    { kind: 'struct', pattern: '^(?<export>pub(?:\\([^)]*\\))?\\s+)?struct\\s+(?<name>[A-Za-z_]\\w*)', exported: 'marker' },
    { kind: 'enum', pattern: '^(?<export>pub(?:\\([^)]*\\))?\\s+)?enum\\s+(?<name>[A-Za-z_]\\w*)', exported: 'marker' },
    { kind: 'trait', pattern: '^(?<export>pub(?:\\([^)]*\\))?\\s+)?trait\\s+(?<name>[A-Za-z_]\\w*)', exported: 'marker' },
    { kind: 'type', pattern: '^(?<export>pub(?:\\([^)]*\\))?\\s+)?type\\s+(?<name>[A-Za-z_]\\w*)', exported: 'marker' },
    { kind: 'module', pattern: '^(?<export>pub(?:\\([^)]*\\))?\\s+)?mod\\s+(?<name>[A-Za-z_]\\w*)', exported: 'marker' },
  ] },
  { id: 'java', extensions: ['java'], prefilter: '(class|interface|enum|record)[[:space:]]', declarations: [
    { kind: 'class', pattern: '^\\s*(?<export>public\\s+)?(?:(?:abstract|final|static|sealed|non-sealed|strictfp)\\s+)*(?:class|interface|enum|record)\\s+(?<name>[A-Za-z_]\\w*)', exported: 'marker' },
  ] },
  { id: 'kotlin', extensions: ['kt', 'kts'], prefilter: '(class|interface|object|fun)[[:space:]]', declarations: [
    { kind: 'class', pattern: '^(?<hidden>(?:private|internal)\\s+)?(?:(?:abstract|open|sealed|data|enum|value|annotation|inner)\\s+)*(?:class|interface|object)\\s+(?<name>[A-Za-z_]\\w*)', exported: 'unless-hidden' },
    { kind: 'function', pattern: '^(?<hidden>(?:private|internal)\\s+)?(?:(?:inline|suspend|operator|infix|tailrec)\\s+)*fun\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?(?<name>[A-Za-z_]\\w*)', exported: 'unless-hidden' },
  ] },
  { id: 'csharp', extensions: ['cs'], prefilter: '(class|interface|struct|enum|record)[[:space:]]', declarations: [
    { kind: 'class', pattern: '^\\s*(?<export>public\\s+)?(?:(?:abstract|sealed|static|partial|readonly|ref|unsafe)\\s+)*(?:class|interface|struct|enum|record)\\s+(?<name>[A-Za-z_]\\w*)', exported: 'marker' },
  ] },
  { id: 'ruby', extensions: ['rb'], prefilter: '^[[:space:]]*(class|module|def)[[:space:]]', declarations: [
    { kind: 'class', pattern: '^\\s*(?:class|module)\\s+(?<name>[A-Z]\\w*)', exported: 'always' },
    { kind: 'method', pattern: '^\\s*def\\s+(?:self\\.)?(?<name>[a-z_]\\w*[?!=]?)', exported: 'always' },
  ] },
  { id: 'php', extensions: ['php'], prefilter: '(class|interface|trait|enum|function)[[:space:]]', declarations: [
    { kind: 'class', pattern: '^\\s*(?:(?:abstract|final|readonly)\\s+)*(?:class|interface|trait|enum)\\s+(?<name>[A-Za-z_]\\w*)', exported: 'always' },
    { kind: 'function', pattern: '^function\\s+(?<name>[A-Za-z_]\\w*)', exported: 'always' },
  ] },
];

/** Extensions that describe documentation, data, configuration or assets rather than code units. */
export const nonSourceExtensions = new Set([
  'md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'org', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'properties', 'env', 'lock', 'sum', 'mod', 'csv', 'tsv', 'xml', 'plist', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico',
  'bmp', 'tif', 'tiff', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'wav', 'ogg', 'webm', 'mov', 'pdf', 'zip', 'gz', 'tgz',
  'tar', 'bz2', 'xz', '7z', 'jar', 'map', 'log', 'snap', 'patch', 'diff', 'pem', 'crt', 'key', 'db', 'sqlite', 'sqlite3',
]);

export function extensionOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

/** Test/fixture files by generic naming conventions shared across ecosystems. */
export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|specs?|fixtures?|testdata)\//i.test(path)
    || /(^|\/)[^/]*[._-](test|spec)s?\.[^/]+$/i.test(path)
    || /(^|\/)test_[^/]+$/i.test(path);
}

function compile(pattern: string, id: string): RegExp {
  try { return new RegExp(pattern); }
  catch { invariant(false, 'KNOWLEDGE_LANGUAGE', `Invalid pattern in language profile ${id}`); throw new Error('unreachable'); }
}

export interface CompiledLanguage {
  profile: LanguageProfile;
  declarations: { kind: string; regex: RegExp; exported: LanguageProfile['declarations'][number]['exported'] }[];
}

/** Project profiles replace built-in profiles with the same id, then claim their extensions first. */
export function resolveLanguages(custom: readonly LanguageProfile[] = []): CompiledLanguage[] {
  const parsed = custom.map(p => languageProfileSchema.parse(p));
  invariant(new Set(parsed.map(p => p.id)).size === parsed.length, 'KNOWLEDGE_LANGUAGE', 'Duplicate knowledge.languages id');
  const overridden = new Set(parsed.map(p => p.id));
  const profiles = [...parsed, ...builtinLanguages.filter(p => !overridden.has(p.id))];
  const claimed = new Set<string>();
  return profiles.map(profile => {
    const extensions = profile.extensions.map(x => x.toLowerCase()).filter(x => !claimed.has(x));
    extensions.forEach(x => claimed.add(x));
    const declarations = profile.declarations.map(d => {
      invariant(/\(\?<name>/.test(d.pattern), 'KNOWLEDGE_LANGUAGE', `Pattern in language profile ${profile.id} needs a named group "name"`);
      return { kind: d.kind, regex: compile(d.pattern, profile.id), exported: d.exported };
    });
    return { profile: { ...profile, extensions }, declarations };
  }).filter(l => l.profile.extensions.length > 0);
}

export function isExported(rule: CompiledLanguage['declarations'][number]['exported'], name: string, groups: Record<string, string | undefined>): boolean {
  switch (rule) {
    case 'always': return true;
    case 'marker': return Boolean(groups.export);
    case 'capitalized': return /^[A-Z]/.test(name);
    case 'not-underscore': return !name.startsWith('_');
    case 'unless-hidden': return !groups.hidden;
  }
}

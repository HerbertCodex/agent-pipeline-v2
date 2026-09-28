export function parseRobots(text) {
    const groups = [];
    const sitemaps = [];
    let current = null;
    let lastWasAgent = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
        if (!m)
            continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (key === 'user-agent') {
            if (!current || !lastWasAgent) {
                current = { agents: [], rules: [] };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            lastWasAgent = true;
            continue;
        }
        lastWasAgent = false;
        if (key === 'sitemap') {
            if (value)
                sitemaps.push(value);
            continue;
        }
        if ((key === 'allow' || key === 'disallow') && current) {
            // An empty Disallow allows everything: no rule.
            if (value)
                current.rules.push({ allow: key === 'allow', path: value });
        }
    }
    return { groups, sitemaps };
}
/** The group that applies to a crawler: the one naming its product token (case-insensitive), else `*`, else none. */
export function robotsGroup(robots, agent) {
    const token = agent.toLowerCase();
    const named = robots.groups.filter(g => g.agents.some(a => a !== '*' && a === token));
    if (named.length)
        return named;
    return robots.groups.filter(g => g.agents.includes('*'));
}
function ruleMatches(pattern, path) {
    let regex = '^';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*')
            regex += '.*';
        else if (c === '$' && i === pattern.length - 1)
            regex += '$';
        else
            regex += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(regex).test(path);
}
/** Whether a crawler may fetch a path: the longest matching rule wins, Allow on a tie; no rule: allowed. */
export function robotsAllows(robots, agent, path) {
    let best = null;
    for (const group of robotsGroup(robots, agent)) {
        for (const rule of group.rules) {
            if (!ruleMatches(rule.path, path))
                continue;
            if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow && !best.allow))
                best = rule;
        }
    }
    return { allowed: best ? best.allow : true, rule: best };
}
export function parseSitemap(xml) {
    const kind = /<(?:[A-Za-z0-9]+:)?urlset[\s>]/.test(xml) ? 'urlset' : /<(?:[A-Za-z0-9]+:)?sitemapindex[\s>]/.test(xml) ? 'sitemapindex' : 'unknown';
    const locs = [...xml.matchAll(/<(?:[A-Za-z0-9]+:)?loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/(?:[A-Za-z0-9]+:)?loc>/g)].map(m => decodeEntities(m[1].trim()));
    return { kind, locs };
}
/** Path of a URL for comparisons between the audited origin and absolute URLs of another host (a preview's sitemap names production). */
export function pagePath(url, base) {
    try {
        const u = new URL(url, base);
        return `${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`;
    }
    catch {
        return null;
    }
}
export function decodeEntities(text) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (all, code) => {
        if (code[0] === '#') {
            const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
        }
        return named[code.toLowerCase()] ?? all;
    });
}
/** Attributes of a start tag (`<meta name="x" content='y' async>`), names lowercased, values decoded. */
export function attributes(tag) {
    const out = {};
    const body = tag.replace(/^<[A-Za-z0-9-]+/, '').replace(/\/?>$/, '');
    for (const m of body.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        const name = m[1].toLowerCase();
        if (!(name in out))
            out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    }
    return out;
}
/** What crawlers read in the server HTML: `lang`, title, description, canonical, robots, hreflang alternates, JSON-LD. */
export function parseHead(html) {
    const text = html.replace(/<!--[\s\S]*?-->/g, '');
    const scripts = [];
    const withoutScripts = text.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (_all, attrs, body) => {
        scripts.push({ attrs: attributes(`<script${attrs}>`), body });
        return '';
    });
    const tags = (name) => [...withoutScripts.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map(m => attributes(m[0]));
    const html0 = tags('html')[0];
    const titles = [...withoutScripts.replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, '').matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)].map(m => decodeEntities(m[1]).replace(/\s+/g, ' ').trim());
    const metas = tags('meta');
    const links = tags('link');
    const rel = (l, value) => (l['rel'] ?? '').toLowerCase().split(/\s+/).includes(value);
    return {
        lang: html0 && 'lang' in html0 ? html0['lang'].trim() : null,
        titles,
        descriptions: metas.filter(m => (m['name'] ?? '').toLowerCase() === 'description').map(m => (m['content'] ?? '').replace(/\s+/g, ' ').trim()),
        canonicals: links.filter(l => rel(l, 'canonical')).map(l => (l['href'] ?? '').trim()),
        robots: metas.filter(m => ['robots', 'googlebot'].includes((m['name'] ?? '').toLowerCase())).map(m => (m['content'] ?? '').toLowerCase()),
        alternates: links.filter(l => rel(l, 'alternate') && 'hreflang' in l).map(l => ({ hreflang: l['hreflang'].trim(), href: (l['href'] ?? '').trim() })),
        jsonLd: scripts.filter(s => (s.attrs['type'] ?? '').trim().toLowerCase() === 'application/ld+json').map(s => s.body),
    };
}
/** Problems of one JSON-LD block: JSON that does not parse, a node without `@context` (top level) or `@type`. */
export function jsonLdIssues(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch (error) {
        return [`JSON-LD illisible : ${error.message}`];
    }
    const nodes = Array.isArray(value) ? value : [value];
    if (!nodes.length)
        return ['JSON-LD vide'];
    const issues = [];
    for (const node of nodes) {
        if (node === null || typeof node !== 'object' || Array.isArray(node)) {
            issues.push('JSON-LD : un nœud n\'est pas un objet');
            continue;
        }
        const n = node;
        const context = n['@context'];
        const contextOk = (typeof context === 'string' && context.length > 0) || (context !== null && typeof context === 'object');
        if (!contextOk)
            issues.push('JSON-LD sans @context');
        const graph = n['@graph'];
        const typed = (x) => x !== null && typeof x === 'object' && (typeof x['@type'] === 'string' || Array.isArray(x['@type']));
        if (Array.isArray(graph)) {
            if (!graph.length)
                issues.push('JSON-LD : @graph vide');
            graph.forEach((g, i) => { if (!typed(g))
                issues.push(`JSON-LD : nœud ${i + 1} de @graph sans @type`); });
        }
        else if (!typed(n))
            issues.push('JSON-LD sans @type');
    }
    return issues;
}
/** A hreflang value: `x-default` or a language tag (`fr`, `fr-FR`, `zh-Hant-TW`). */
export const HREFLANG = /^(?:x-default|[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|\d{3}))?)$/;
const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const described = (f) => f.error ? `inaccessible (${f.error})` : `statut HTTP ${f.status}`;
/** Every finding of the readiness checks, `off` checks left out. */
export function readinessFindings(input) {
    const findings = [];
    const notes = [];
    const add = (check, page, message) => {
        const level = input.checks[check];
        if (level !== 'off')
            findings.push({ check, level, page, message });
    };
    const heads = new Map();
    for (const page of input.pages) {
        if (page.html === null || page.status !== 200) {
            const redirect = page.status !== null && page.status >= 300 && page.status < 400;
            add('status', page.path, `page ${described(page)}${redirect ? ' (redirection : déclarer l\'adresse finale)' : ''} ; 200 attendu, balises non lues`);
            continue;
        }
        heads.set(page.path, parseHead(page.html));
    }
    // robots.txt: reachable, and no page closed to the crawlers named, nor marked noindex.
    let robots = null;
    if (input.robots.status === 200 && input.robots.text !== null)
        robots = parseRobots(input.robots.text);
    else
        add('robots', null, `robots.txt ${described(input.robots)} (${input.robots.url})`);
    for (const page of input.pages) {
        const path = pagePath(page.url) ?? page.path;
        if (robots) {
            for (const agent of input.agents) {
                const verdict = robotsAllows(robots, agent, path);
                if (!verdict.allowed)
                    add('robots', page.path, `robots.txt interdit la page à ${agent} (règle « Disallow: ${verdict.rule?.path} »)`);
            }
        }
        const directives = [...(heads.get(page.path)?.robots ?? []), (page.xRobotsTag ?? '').toLowerCase()].join(',');
        if (/(^|[\s,])(noindex|none)([\s,]|$)/.test(directives))
            add('robots', page.path, 'page marquée noindex (balise meta robots ou en-tête X-Robots-Tag)');
    }
    // Sitemaps: declared in robots.txt, readable, listing every audited page.
    if (robots && !robots.sitemaps.length)
        add('sitemap', null, 'aucun sitemap déclaré dans robots.txt (ligne « Sitemap: <adresse absolue> »)');
    const listed = new Set();
    let readable = 0;
    for (const sitemap of input.sitemaps) {
        if (sitemap.status !== 200 || sitemap.text === null) {
            add('sitemap', null, `sitemap ${sitemap.url} ${described(sitemap)}`);
            continue;
        }
        const parsed = parseSitemap(sitemap.text);
        if (parsed.kind === 'unknown') {
            add('sitemap', null, `sitemap ${sitemap.url} : ni <urlset> ni <sitemapindex>`);
            continue;
        }
        readable++;
        if (parsed.kind === 'urlset')
            for (const loc of parsed.locs) {
                const p = pagePath(loc);
                if (p)
                    listed.add(p);
            }
    }
    if (!input.sitemaps.length && !(robots && robots.sitemaps.length))
        add('sitemap', null, 'aucun sitemap lisible');
    if (readable) {
        for (const page of input.pages) {
            const p = pagePath(page.url) ?? page.path;
            if (!listed.has(p))
                add('sitemap', page.path, 'page absente du sitemap');
        }
    }
    // Per page: title, description, canonical, lang, JSON-LD, hreflang.
    const titles = new Map();
    const descriptions = new Map();
    let withJsonLd = 0;
    for (const page of input.pages) {
        const head = heads.get(page.path);
        if (!head)
            continue;
        const title = head.titles.find(t => t.length > 0);
        if (!title)
            add('title', page.path, 'balise <title> absente ou vide');
        else {
            if (head.titles.length > 1)
                add('title', page.path, `${head.titles.length} balises <title>`);
            titles.set(title, [...(titles.get(title) ?? []), page.path]);
        }
        const description = head.descriptions.find(d => d.length > 0);
        if (!description)
            add('description', page.path, 'meta description absente ou vide');
        else {
            if (head.descriptions.length > 1)
                add('description', page.path, `${head.descriptions.length} meta description`);
            descriptions.set(description, [...(descriptions.get(description) ?? []), page.path]);
        }
        if (!head.canonicals.length)
            add('canonical', page.path, 'balise <link rel="canonical"> absente');
        else if (head.canonicals.length > 1)
            add('canonical', page.path, `${head.canonicals.length} balises canonical (une seule attendue)`);
        else {
            const href = head.canonicals[0];
            let absolute = null;
            try {
                absolute = /^https?:\/\//i.test(href) ? new URL(href) : null;
            }
            catch {
                absolute = null;
            }
            if (!absolute)
                add('canonical', page.path, `canonical « ${href} » n'est pas une adresse absolue`);
            else if (pagePath(absolute.href) !== (pagePath(page.url) ?? page.path))
                add('canonical', page.path, `canonical vers une autre page : ${absolute.href}`);
            else if (absolute.origin !== new URL(input.origin).origin)
                notes.push(`${page.path} : canonical sur ${absolute.origin} (origine auditée : ${new URL(input.origin).origin})`);
        }
        if (!head.lang)
            add('lang', page.path, 'attribut lang absent de <html>');
        else if (!LANG.test(head.lang))
            add('lang', page.path, `attribut lang invalide : « ${head.lang} »`);
        if (head.jsonLd.length)
            withJsonLd++;
        head.jsonLd.forEach((raw, i) => { for (const issue of jsonLdIssues(raw))
            add('jsonLd', page.path, head.jsonLd.length > 1 ? `bloc ${i + 1} : ${issue}` : issue); });
        if (head.alternates.length) {
            const seen = new Set();
            for (const alt of head.alternates) {
                if (!HREFLANG.test(alt.hreflang))
                    add('hreflang', page.path, `valeur hreflang invalide : « ${alt.hreflang} »`);
                if (seen.has(alt.hreflang.toLowerCase()))
                    add('hreflang', page.path, `hreflang « ${alt.hreflang} » en double`);
                seen.add(alt.hreflang.toLowerCase());
                if (!/^https?:\/\//i.test(alt.href))
                    add('hreflang', page.path, `hreflang « ${alt.hreflang} » vers une adresse non absolue : « ${alt.href} »`);
            }
            const self = pagePath(page.url) ?? page.path;
            if (!head.alternates.some(a => pagePath(a.href) === self))
                add('hreflang', page.path, 'la page ne se cite pas elle-même parmi ses alternatives hreflang');
            // Reciprocity among the audited pages: B named by A as an alternative must name A back.
            for (const alt of head.alternates) {
                const target = input.pages.find(p => (pagePath(p.url) ?? p.path) === pagePath(alt.href) && p.path !== page.path);
                const other = target ? heads.get(target.path) : undefined;
                if (target && other && !other.alternates.some(a => pagePath(a.href) === self))
                    add('hreflang', page.path, `${target.path} ne renvoie pas vers ${page.path} (hreflang non réciproque)`);
            }
        }
    }
    for (const [title, pages] of titles)
        if (pages.length > 1)
            add('title', null, `titre identique sur ${pages.join(', ')} : « ${title.slice(0, 80)} »`);
    for (const [description, pages] of descriptions)
        if (pages.length > 1)
            add('description', null, `description identique sur ${pages.join(', ')} : « ${description.slice(0, 80)} »`);
    if (heads.size && !withJsonLd)
        notes.push('aucune donnée structurée JSON-LD sur les pages auditées (facultatif, utile aux moteurs et aux IA : Organization, WebSite, FAQPage, BreadcrumbList...)');
    // llms.txt, when the project expects one.
    if (input.llms) {
        const l = input.llms;
        if (l.status !== 200 || l.text === null)
            add('llmsTxt', null, `llms.txt ${described(l)} (${l.url})`);
        else if (!/^\s*#\s+\S/.test(l.text))
            add('llmsTxt', null, 'llms.txt ne commence pas par un titre Markdown (« # Nom du site »)');
        else if (l.contentType && !/^text\/(plain|markdown)/i.test(l.contentType))
            add('llmsTxt', null, `llms.txt servi en ${l.contentType} (text/plain ou text/markdown attendu)`);
    }
    return { findings, notes };
}
//# sourceMappingURL=readiness.js.map
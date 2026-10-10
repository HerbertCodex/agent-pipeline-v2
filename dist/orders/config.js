import { s } from '../domain/schema.js';
import { DOMAIN_PATTERN, readPublicKey } from './envelope.js';
/**
 * `rules.operatorOrders` of `.apv/config.json` (docs/REGLES.md, « Fusion sur ordre signé »), always read at the base of
 * the merge (a pull request never changes the rules it is checked against):
 * - `domain`: the domain of the signed messages of the project (`<domain>:signed:1:<kind>`, comment `<domain>-signed:1`);
 * - `publicKeys`: the Ed25519 public keys of the signer (PEM SPKI or its base64 line), two during a rotation; never a
 *   private key (refused by the loader, never echoed);
 * - `attestation`: the address of the production that attests an order is open, with `{nonce}` and `{challenge}`
 *   replaced by APV (HTTPS only, no exception: the tests of the tool replace the network, never the address), and
 *   `maxAgeSeconds`, the longest time between the attestation and the push of the merge (120 by default);
 * - `publicationBranch` (optional): the branch the publication pull request must come from, `{slug}` replaced by the
 *   `slug` the order signed (`publication/{slug}`); absent, only the command of the project binds that pull request to
 *   the order (closed list of files, content regenerated from the signed proposal);
 * - `verify.publication`: the command of the project that checks the content of a step, run by APV from a clean copy
 *   of the base (`{{base}}`, `{{head}}`, `{{step}}` replaced as whole arguments, the verified order on its input).
 */
export const DEFAULT_ATTESTATION_MAX_AGE_SECONDS = 120;
export const DEFAULT_ATTESTATION_TIMEOUT_MS = 15_000;
export const DEFAULT_VERIFY_TIMEOUT_MS = 900_000;
/** Placeholders of `verify.publication`, replaced as whole arguments. */
export const VERIFY_PLACEHOLDERS = ['base', 'head', 'step'];
export const operatorOrdersSchema = s.object({
    domain: s.string(1, 63, DOMAIN_PATTERN),
    publicKeys: s.array(s.string(1, 4096), 1, 4),
    attestation: s.object({
        url: s.string(1, 2000),
        maxAgeSeconds: s.default(s.number(10, 600), DEFAULT_ATTESTATION_MAX_AGE_SECONDS),
        timeoutMs: s.default(s.number(1000, 120_000), DEFAULT_ATTESTATION_TIMEOUT_MS),
    }),
    publicationBranch: s.optional(s.string(1, 200, /^[A-Za-z0-9._/{}-]+$/)),
    verify: s.object({
        publication: s.array(s.string(1, 4000), 1, 100),
        timeoutMs: s.default(s.number(1000, 3_600_000), DEFAULT_VERIFY_TIMEOUT_MS),
    }),
});
const PROBLEMS = {
    private: 'clé privée refusée (seule la clé publique se déclare ; la clé privée reste en production)',
    unreadable: 'clé publique illisible (PEM SPKI ou sa ligne base64 attendus)',
    not_ed25519: 'clé publique d\'un autre algorithme que Ed25519',
};
/** The attestation address with its placeholders replaced (values already checked as UUID). */
export function attestationUrl(template, nonce, challenge) {
    return template.replace('{nonce}', encodeURIComponent(nonce)).replace('{challenge}', encodeURIComponent(challenge));
}
/** The branch of the publication pull request an order names (`publicationBranch` with its slug), or null when undeclared or unreadable. */
export function publicationBranchOf(template, slug) {
    if (template === undefined || typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80)
        return null;
    return template.replace('{slug}', slug);
}
/** Every problem of a declaration that the schema cannot see: keys, address, placeholders. Never echoes a key. */
export function operatorOrdersIssues(settings) {
    const issues = [];
    const ids = new Set();
    settings.publicKeys.forEach((text, index) => {
        const read = readPublicKey(text);
        if ('problem' in read)
            issues.push(`rules.operatorOrders.publicKeys[${index}] : ${PROBLEMS[read.problem]}`);
        else if (ids.has(read.id))
            issues.push(`rules.operatorOrders.publicKeys[${index}] : clé déclarée deux fois (${read.id})`);
        else
            ids.add(read.id);
    });
    const template = settings.attestation.url;
    const count = (mark) => template.split(mark).length - 1;
    if (count('{nonce}') !== 1 || count('{challenge}') !== 1 || template.replace('{nonce}', '').replace('{challenge}', '').match(/[{}]/)) {
        issues.push('rules.operatorOrders.attestation.url : {nonce} et {challenge} attendus une fois chacun, aucune autre accolade');
    }
    else {
        let url = null;
        try {
            url = new URL(attestationUrl(template, '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000'));
        }
        catch {
            url = null;
        }
        if (!url)
            issues.push('rules.operatorOrders.attestation.url : adresse illisible');
        else if (url.username || url.password)
            issues.push('rules.operatorOrders.attestation.url : aucun identifiant dans l\'adresse');
        else if (url.protocol !== 'https:') {
            issues.push('rules.operatorOrders.attestation.url : HTTPS attendu');
        }
    }
    const branch = settings.publicationBranch;
    if (branch !== undefined && (branch.split('{slug}').length !== 2 || /[{}]/.test(branch.replace('{slug}', '')) || branch.includes('..')
        || /^[/-]/.test(branch) || branch.endsWith('/') || branch.endsWith('.lock'))) {
        issues.push('rules.operatorOrders.publicationBranch : {slug} attendu une fois, aucune autre accolade, ni « .. », ni « / » ou « - » en tête');
    }
    for (const arg of settings.verify.publication) {
        if (!arg.includes('{{'))
            continue;
        const key = /^\{\{([A-Za-z]+)\}\}$/.exec(arg)?.[1];
        if (!key || !VERIFY_PLACEHOLDERS.includes(key)) {
            issues.push(`rules.operatorOrders.verify.publication : marque inconnue ou partielle ${arg} (arguments entiers seulement : ${VERIFY_PLACEHOLDERS.map(k => `{{${k}}}`).join(', ')})`);
        }
    }
    return issues;
}
/** One line of `apv status`: the declaration of the working tree, as the merge on order reads it at the base. */
export function operatorOrdersLine(settings, error = null) {
    if (error)
        return `Ordres signés (rules.operatorOrders) : configuration illisible, aucune fusion sur ordre possible`;
    if (!settings)
        return 'Ordres signés (rules.operatorOrders) : non déclarés (aucune fusion sur ordre signé)';
    const keys = settings.publicKeys.map(readPublicKey).map(k => ('id' in k ? k.id : 'illisible')).join(', ');
    let host = 'adresse illisible';
    try {
        host = new URL(attestationUrl(settings.attestation.url, 'n', 'c')).host;
    }
    catch { /* said as unreadable */ }
    return `Ordres signés (rules.operatorOrders) : domaine ${settings.domain}, clé(s) ${keys} ; attestation par ${host}, `
        + `${settings.attestation.maxAgeSeconds} s au plus avant la poussée ; vérification du projet : ${settings.verify.publication.join(' ')} `
        + '(lue à la base par apv stack merge --order)';
}
//# sourceMappingURL=config.js.map
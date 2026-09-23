export const meta = {
  name: 'revues',
  description: "Revues indépendantes APV en parallèle et en lecture seule (sécurité, fidélité, données, RGPD), chacune sur sa copie isolée du même commit, puis constats consolidés et dédoublonnés. Lancé par /apv:review, jamais seul.",
  phases: [
    { title: 'Revues', detail: 'un agent de revue par domaine, en parallèle, sur sa copie détachée' },
    { title: 'Consolidation', detail: 'constats fusionnés quand ils décrivent le même défaut au même endroit' },
  ],
}

// Script body (format of Claude Code dynamic workflows: agent(), parallel(), phase(), log(), args).
// The project lead (/apv:review) creates one detached worktree per domain, launches this workflow,
// then writes the corrections file and records `apv run set <spec> review:<domain> ...` itself.

const DOMAINS = {
  securite: { agentType: 'apv:qa-securite', prefix: 'S', role: 'revue de sécurité' },
  fidelite: { agentType: 'apv:qa-fidelite', prefix: 'F', role: 'revue de fidélité' },
  donnees: { agentType: 'apv:architecte-donnees', prefix: 'D', role: 'revue des données (mode revue, lecture seule)' },
  rgpd: { agentType: 'apv:dpo', prefix: 'R', role: 'revue RGPD (lecture seule hormis .apv/rgpd/ si le chef de projet le demande)' },
}
const SEVERITIES = ['critique', 'eleve', 'moyen', 'faible', 'info']

const input = args || {}
if (typeof input.commit !== 'string' || !input.commit || !Array.isArray(input.reviews) || !input.reviews.length) {
  throw new Error(
    'Workflow apv:revues lancé sans ses paramètres. Il est lancé par /apv:review avec ' +
    '{ commit, branch, specFile, common, reviews: [{ domain, copy, context }] }.',
  )
}
const seen = new Set()
for (const review of input.reviews) {
  if (!review || !DOMAINS[review.domain]) throw new Error('Domaine de revue inconnu : ' + (review && review.domain) + ' (securite, fidelite, donnees, rgpd).')
  if (typeof review.copy !== 'string' || !review.copy) throw new Error('La revue ' + review.domain + ' a besoin de sa copie isolée (copy).')
  if (seen.has(review.domain)) throw new Error('Domaine en double : ' + review.domain)
  seen.add(review.domain)
}

const APV = typeof input.apv === 'string' && input.apv ? input.apv : 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"'

const FINDINGS = {
  type: 'object',
  required: ['domain', 'commit', 'findings', 'notVerified', 'cleanup', 'summary'],
  properties: {
    domain: { type: 'string' },
    commit: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'required', 'title', 'location', 'evidence', 'fix'],
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          required: { type: 'boolean' },
          title: { type: 'string' },
          location: { type: 'string' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
    notVerified: { type: 'array', items: { type: 'string' } },
    cleanup: { type: 'string' },
    summary: { type: 'string' },
  },
}

const GROUPS = {
  type: 'object',
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ids', 'reason'],
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
      },
    },
  },
}

function reviewPrompt(review) {
  const domain = DOMAINS[review.domain]
  return [
    'Tu fais la ' + domain.role + ' du commit `' + input.commit + '`' + (input.branch ? ' (branche `' + input.branch + '`)' : '') + '.',
    'Ta copie isolée, détachée sur ce commit, est `' + review.copy + '` : travaille uniquement dedans (`cd` au début de chaque commande), jamais dans le dépôt principal ni dans le worktree d\'un autre agent.',
    'Lecture seule : aucun commit, aucune poussée, aucune écriture sur un service externe ; tes scripts, captures et rapports vont dans un dossier temporaire hors de la copie.',
    input.specFile ? 'Spec : `' + input.specFile + '` (critères, exigences de sécurité, menaces, tests négatifs).' : '',
    '`apv` désigne `' + APV + '` s\'il n\'est pas sur le PATH.',
    typeof input.common === 'string' && input.common ? 'Consigne commune : ' + input.common : '',
    typeof review.context === 'string' && review.context ? 'Consigne de ta revue : ' + review.context : '',
    '',
    'Rapport (sortie structurée) : domain = `' + review.domain + '` ; commit ; findings (gravité sur l\'échelle commune critique, eleve, moyen, faible, info, où « bloquant » vaut critique ou eleve selon l\'impact ;',
    'required = true pour « requis », false pour « conseil » ; title ; location = chemin et ligne, ou écran, état, largeur et thème ; evidence = la preuve observée ; fix = la correction attendue) ;',
    'notVerified = ce qui n\'a pas pu être vérifié, avec la raison ; cleanup = confirmation du nettoyage (utilisateurs de test, serveurs, dossiers temporaires) ; summary = moins de 300 mots.',
    'Un écart déjà validé par l\'opérateur au registre n\'est pas un constat. Aucune attaque, capture ou mesure annoncée sans l\'avoir faite.',
  ].filter(line => line !== '').join('\n')
}

phase('Revues')
log('Revues du commit ' + input.commit + ' : ' + input.reviews.map(r => r.domain).join(', '))

const results = await parallel(input.reviews.map(review => () =>
  agent(reviewPrompt(review), {
    label: review.domain,
    phase: 'Revues',
    agentType: DOMAINS[review.domain].agentType,
    schema: FINDINGS,
  }),
))

const reports = []
const findings = []
const incomplete = []
input.reviews.forEach((review, index) => {
  const result = results[index]
  if (!result) {
    incomplete.push(review.domain)
    return
  }
  const prefix = DOMAINS[review.domain].prefix
  result.findings.forEach((finding, n) => findings.push(Object.assign({ id: prefix + (n + 1), domain: review.domain }, finding)))
  reports.push({ domain: review.domain, findings: result.findings.length, notVerified: result.notVerified, cleanup: result.cleanup, summary: result.summary })
})
if (incomplete.length) log('Revues sans rapport (agent arrêté ou erreur) : ' + incomplete.join(', ') + '. À relancer.')

// Cross-domain deduplication needs every finding at once: this is the only barrier of the workflow.
let groups = findings.map(f => ({ ids: [f.id], reason: '' }))
if (findings.length > 1 && reports.length > 1) {
  phase('Consolidation')
  const merged = await agent([
    'Voici les constats de plusieurs revues indépendantes du même commit, en JSON :',
    JSON.stringify(findings.map(f => ({ id: f.id, domain: f.domain, severity: f.severity, title: f.title, location: f.location, fix: f.fix }))),
    '',
    'Regroupe les constats qui décrivent le MÊME défaut au MÊME endroit (même cause, même correction), quel que soit leur domaine.',
    'Deux défauts différents au même endroit restent séparés. Chaque identifiant apparaît dans exactement un groupe ; un constat sans doublon forme un groupe à lui seul.',
    'Ne supprime aucun constat et n\'en invente aucun. reason : en une phrase, pourquoi les constats d\'un groupe sont le même défaut (vide pour un groupe seul).',
  ].join('\n'), { label: 'dédoublonnage', phase: 'Consolidation', schema: GROUPS })
  if (merged) {
    const known = new Set(findings.map(f => f.id))
    const used = new Set()
    const clean = []
    for (const group of merged.groups) {
      const ids = group.ids.filter(id => known.has(id) && !used.has(id))
      ids.forEach(id => used.add(id))
      if (ids.length) clean.push({ ids, reason: group.reason })
    }
    const forgotten = findings.filter(f => !used.has(f.id)).map(f => f.id)
    if (forgotten.length) log('Constats oubliés par la consolidation, gardés seuls : ' + forgotten.join(', '))
    groups = clean.concat(forgotten.map(id => ({ ids: [id], reason: '' })))
  } else {
    log('Consolidation indisponible : les constats restent séparés.')
  }
}

const byId = new Map(findings.map(f => [f.id, f]))
const rank = severity => SEVERITIES.indexOf(severity)
const consolidated = groups.map(group => {
  const members = group.ids.map(id => byId.get(id))
  const lead = members.slice().sort((a, b) => rank(a.severity) - rank(b.severity))[0]
  return {
    id: lead.id,
    ids: group.ids,
    domains: [...new Set(members.map(m => m.domain))],
    severity: lead.severity,
    required: members.some(m => m.required),
    title: lead.title,
    location: members.map(m => m.location).filter((l, i, all) => all.indexOf(l) === i).join(' ; '),
    evidence: members.map(m => m.id + ' : ' + m.evidence).join('\n'),
    fix: lead.fix,
    reason: group.reason,
  }
}).sort((a, b) => rank(a.severity) - rank(b.severity))

return { commit: input.commit, branch: input.branch || null, reports, incomplete, findings: consolidated, raw: findings }

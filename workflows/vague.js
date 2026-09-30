export const meta = {
  name: 'vague',
  description: "Vague d'implementers APV : un agent apv:implementer par tâche prête, chacun dans son worktree, rapport structuré par tâche. Lancé par /apv:run, jamais seul.",
  phases: [
    { title: 'Implémentation', detail: 'un implementer par tâche, en parallèle, chacun dans son worktree' },
  ],
}

// Script body (format of Claude Code dynamic workflows: agent(), pipeline(), phase(), log(), args).
// The project lead (/apv:run) computes every input from `apv run next` and the plan, launches this
// workflow, then records each result itself with `apv run set` and `apv scope check`: the script
// never writes the run state, never pushes and never merges.

const input = args || {}
const missing = ['specId', 'specFile', 'base', 'baseCommit', 'brief'].filter(key => typeof input[key] !== 'string' || !input[key])
if (missing.length || !Array.isArray(input.tasks) || !input.tasks.length) {
  throw new Error(
    'Workflow apv:vague lancé sans ses paramètres (' + (missing.join(', ') || 'tasks') + '). ' +
    'Il est lancé par /apv:run avec { specId, specFile, base, baseCommit, brief, notes, wave, context, tasks: [{ id, branch, wave, resume }] } (wave facultatif : un lancement peut réunir des tâches prêtes de plusieurs vagues).',
  )
}
for (const task of input.tasks) {
  if (!task || typeof task.id !== 'string' || !task.id || typeof task.branch !== 'string' || !task.branch) {
    throw new Error('Chaque tâche de apv:vague a un identifiant (id) et une branche (branch).')
  }
}

// `apv` inside the agents: the bundled tool unless the lead passes another command.
const APV = typeof input.apv === 'string' && input.apv ? input.apv : 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"'
const WAVE = input.wave === undefined ? '?' : String(input.wave)

// Calibrated confidence (docs/CONFIANCE.md): each result carries its level and its proof or justification.
// Same list and same check in workflows/revues.js (a workflow loads no module).
const CONFIDENCE = ['prouve', 'probable', 'suppose']

function claimProblems(claim, where, evidenceKey) {
  const key = evidenceKey || 'evidence'
  if (!claim || typeof claim !== 'object') return [where + ' : absent']
  const problems = []
  const level = claim.confidence
  if (level === undefined || level === null || level === '') problems.push(where + ' : niveau de confiance absent (confidence)')
  else if (!CONFIDENCE.includes(level)) problems.push(where + ' : niveau de confiance inconnu « ' + String(level) + ' » (prouve, probable, suppose)')
  const evidence = claim[key]
  if (typeof evidence !== 'string' || !evidence.trim()) {
    problems.push(where + ' : ' + (level === 'prouve' ? 'niveau prouve sans preuve' : 'preuve ou justification absente') + ' (' + key + ')')
  }
  return problems
}

// How a task treated each component, module or route it created or modified (reused, extended, added).
const REUSE_DECISIONS = ['reused', 'extended', 'added']

function reuseProblems(report, where) {
  if (!Array.isArray(report.reuse)) return [where + ' : réutilisation absente (reuse : l\'entrée de la carte du code réutilisée ou étendue, ou l\'ajout justifié ; [] si la tâche ne crée ni ne modifie de composant, de module ou de route)']
  const problems = []
  report.reuse.forEach((entry, index) => {
    const at = where + ' : reuse[' + index + ']'
    if (!entry || typeof entry !== 'object' || typeof entry.item !== 'string' || !entry.item.trim()) return problems.push(at + ' : élément absent (item)')
    if (!REUSE_DECISIONS.includes(entry.decision)) return problems.push(at + ' : décision inconnue « ' + String(entry.decision) + ' » (reused, extended, added)')
    if (entry.decision !== 'added' && (typeof entry.mapEntry !== 'string' || !entry.mapEntry.trim())) problems.push(at + ' : entrée de la carte du code absente (mapEntry) pour ' + entry.item)
    // An entry of the map is a path of the repository (`src/lib/components/ui/Select.svelte`), never a sentence.
    else if (entry.decision !== 'added' && !/^[^\s]+\/[^\s]+$/.test(entry.mapEntry.trim())) problems.push(at + ' : mapEntry « ' + entry.mapEntry + ' » n\'est pas un chemin de la carte du code (dossier/fichier)')
    else if (entry.decision === 'reused' && entry.mapEntry.trim() === entry.item.trim()) problems.push(at + ' : ' + entry.item + ' se réutilise lui-même (reused) : c\'est extended, ou une autre entrée de la carte')
    if (entry.decision === 'added' && (typeof entry.justification !== 'string' || !entry.justification.trim())) problems.push(at + ' : ajout sans justification (justification) pour ' + entry.item)
  })
  return problems
}

// Where each code file the task created was put, and why (docs/STRUCTURE.md): a file never lands in a flat folder by default.
function placementProblems(report, where) {
  if (!Array.isArray(report.placement)) return [where + ' : placement absent (placement : chaque fichier de code créé, son dossier et la raison ; [] si la tâche n\'en crée aucun)']
  const problems = []
  report.placement.forEach((entry, index) => {
    const at = where + ' : placement[' + index + ']'
    if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string' || !entry.file.trim()) return problems.push(at + ' : fichier absent (file)')
    if (typeof entry.folder !== 'string' || !entry.folder.trim()) return problems.push(at + ' : dossier absent (folder) pour ' + entry.file)
    const folder = entry.folder.trim().replace(/\/+$/, '')
    if (!entry.file.trim().startsWith(folder + '/') || entry.file.trim().slice(folder.length + 1).includes('/')) problems.push(at + ' : ' + entry.file + ' n\'est pas directement dans ' + folder)
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) problems.push(at + ' : raison absente (reason) pour ' + entry.file)
  })
  return problems
}

const REPORT = {
  type: 'object',
  required: ['taskId', 'status', 'confidence', 'evidence', 'branch', 'worktree', 'commit', 'headRevParse', 'headLog', 'checks', 'scopeCheck', 'outOfScopeFiles', 'reuse', 'placement', 'summary', 'openPoints'],
  properties: {
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['done', 'failed', 'wip'] },
    confidence: { type: 'string', enum: CONFIDENCE },
    evidence: { type: 'string', minLength: 1 },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    commit: { type: 'string' },
    // Raw outputs, pasted as printed: an id typed from memory was invented past its 7 first characters (pilot project, 24 September 2026).
    headRevParse: { type: 'string', minLength: 1 },
    headLog: { type: 'string', minLength: 1 },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['command', 'result', 'tests'],
        properties: {
          command: { type: 'string' },
          result: { type: 'string', enum: ['pass', 'fail', 'not-run'] },
          tests: { type: 'string' },
        },
      },
    },
    scopeCheck: { type: 'string', enum: ['in', 'out', 'not-run'] },
    outOfScopeFiles: { type: 'array', items: { type: 'string' } },
    // One entry per component, module or route created or modified: the entry of the code map reused or extended, or
    // why an addition was needed (operator rule, 30 September 2026: use what exists, share what two features use).
    reuse: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'decision'],
        properties: {
          item: { type: 'string' },
          decision: { type: 'string', enum: REUSE_DECISIONS },
          mapEntry: { type: 'string' },
          justification: { type: 'string' },
        },
      },
    },
    // One entry per code file created: its folder (the sub-folder of its feature, never a flat folder) and why.
    placement: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'folder', 'reason'],
        properties: { file: { type: 'string' }, folder: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    summary: { type: 'string' },
    openPoints: { type: 'array', items: { type: 'string' } },
  },
}

function startLines(task) {
  const lines = [
    '1. Ton worktree part de la branche par défaut du dépôt, pas de ta base. Tant qu\'il est propre, place-toi sur ta branche :',
    '   - si `git rev-parse --verify --quiet ' + task.branch + '` trouve la branche (reprise), `git switch ' + task.branch + '` et reprends depuis son dernier commit ;',
    '   - sinon `git switch -c ' + task.branch + ' ' + input.baseCommit + '`.',
    '   Vérifie ensuite `git log -1` avant d\'écrire quoi que ce soit.',
    '2. Écris le marqueur de tâche `.apv/state/task.json` : {"spec": "' + input.specFile + '", "task": "' + task.id + '"} (ignoré par Git, lu par le hook de rappel des chemins autorisés).',
    '3. Installe les dépendances comme le dit la consigne commune.',
  ]
  if (typeof task.resume === 'string' && task.resume) lines.push('Reprise : ' + task.resume)
  return lines.join('\n')
}

function prompt(task) {
  return [
    'Tu codes la tâche `' + task.id + '` de la spec `' + input.specFile + '` (identifiant `' + input.specId + '`), vague ' + (task.wave === undefined ? WAVE : String(task.wave)) + '.',
    'Base : branche `' + input.base + '`, commit `' + input.baseCommit + '`. Ta branche : `' + task.branch + '`.',
    '',
    '## Démarrage',
    startLines(task),
    '',
    '## Sources',
    '- La tâche `' + task.id + '` dans la spec : description, allowedPaths, critères (acceptanceIds, acceptance[]) et section security.',
    '- La consigne commune du projet : `' + input.brief + '` (règles de code, contrôles exacts, services, verrous, Git, ligne de co-auteur).',
    typeof input.notes === 'string' && input.notes ? '- Les notes de la vague : `' + input.notes + '` (API disponible, fichiers possédés, points d\'extension).' : '- Pas de notes de vague : c\'est la vague des fondations ou une tâche seule.',
    '- Maquettes validées (`' + APV + ' design list`), `.apv/data-model.md` et le registre des décisions quand la tâche les concerne.',
    '- La carte de l\'architecture (`docs/carte-architecture.md`, ou `structure.architectureMap` de `.apv/config.json`) : à lire EN PREMIER (couches, arborescence et conventions de la pile, points d\'entrée). Un nouveau fichier va dans le sous-dossier de sa fonctionnalité, jamais dans un dossier à plat ; un dossier, une route principale ou un point d\'entrée que tu crées reçoit son rôle en une ligne dans le bloc « Rôles » de la carte, dans ta tâche.',
    '- La carte du code `.apv/code-map.md` : à lire AVANT de créer un composant, un module ou une route. Réutilise une entrée, ou étends-la de façon générique (paramètre, variante) ; jamais de copie propre à une fonctionnalité ; ce qui sert à deux fonctionnalités devient partagé et paramétrable, et ce que ton changement rend inutile est retiré.',
    typeof task.extra === 'string' && task.extra ? '- Consigne propre à cette tâche : ' + task.extra : '',
    typeof input.context === 'string' && input.context ? '- Consigne de la vague : ' + input.context : '',
    '',
    '## Fin de tâche',
    '1. Contrôles de tâche au vert : `' + APV + ' gates run --stage task --base ' + input.baseCommit + '` (les contrôles « réservés à la suite complète » ne sont ni lancés ni annoncés verts : le chef de projet passe la suite complète à la dernière intégration de la spec et à la livraison ; entre les deux, tes contrôles de tâche et les tests ciblés sont le filet, donc tous au vert ; sur ta branche, l\'outil refuse `gates run --stage full` pendant les vagues).',
    '   Tests ciblés : si le tableau montre un contrôle « ciblé » (commande `affected`), il a déjà lancé les tests concernés par tes changements ; ne les relance pas, et ne l\'annonce pas comme la suite complète.',
    '   Sinon, tests navigateur : seulement les fichiers e2e que tu as créés ou modifiés, sous `' + APV + ' lock run e2e -- <commande du projet> <fichiers>` (par exemple `npx playwright test <fichiers>`) ; aucun fichier e2e touché, rien à lancer. Jamais la suite navigateur entière.',
    '   Test instable : répète seulement le test en cause (`<fichier>:<ligne>` ou `-g "<titre>"`), `--repeat-each` 20 au plus, sous le verrou `e2e` ; jamais un fichier entier répété sous le verrou. Cherche d\'abord un clic pendant une animation : attends l\'état stable, pas un délai fixe. Projet à interface : tests navigateur en mouvement réduit par défaut (Playwright `reducedMotion: \'reduce\'`), sauf les tests d\'animation.',
    '   Projet sans contrôle marqué `full` : `--stage task` exécute déjà tout, comme avant. Autres ressources partagées sous bail (`' + APV + ' lock run <ressource> -- <commande>`).',
    '   La carte du code ne se commite pas dans une tâche (l\'intégration la régénère une fois par vague, `' + APV + ' map`) : ne commite jamais `.apv/code-map.md`. Un contrôle `reuse` rouge (bloc copié, élément natif réservé, primitive de style redéfinie) se corrige en réutilisant ou en factorisant, jamais en baissant sa gravité ni en élargissant `reuse.ignore`.',
    '   Un contrôle `structure` rouge se corrige en plaçant le fichier dans le sous-dossier qu\'il nomme et en décrivant tout nouveau dossier, route principale ou point d\'entrée dans la carte de l\'architecture ; jamais en relevant le seuil ni en baissant la gravité (compétence `apv:structure`). Ne réécris pas les parties générées de la carte : l\'intégration les régénère avec `' + APV + ' map`.',
    '2. Tout est commité sur `' + task.branch + '` ; aucun fichier non commité.',
    '3. `' + APV + ' scope check --spec ' + input.specFile + ' --task ' + task.id + ' --base ' + input.baseCommit + '` : note son résultat et chaque fichier hors périmètre avec sa raison.',
    '4. Ne pousse pas, ne fusionne pas, ne réécris aucun commit.',
    '',
    '## Rapport (sortie structurée)',
    'taskId ; status (`done` si tout est vert et commité, `wip` si le travail est commité mais inachevé, `failed` sinon) ;',
    'confidence et evidence : ton niveau de confiance sur le résultat annoncé (tâche faite, critères couverts, défaut corrigé, cause d\'un échec) et ce qui le fonde :',
    '`prouve` = preuve reproductible jointe dans evidence (commande exacte et sa sortie, test qui échoue avant et passe après pour une correction, capture) ;',
    '`probable` = lecture du code ou raisonnement vérifiable sans exécution (chemins et lignes cités) ; `suppose` = hypothèse (sur quoi elle repose, ce qui la prouverait).',
    'Une correction dont la cause observée (production, rapport) n\'a pas été reproduite reste au mieux `probable`, même si tes tests passent. Dans le doute, le niveau inférieur. Sans evidence, le rapport est refusé.',
    'branch ; worktree (chemin absolu, sortie de `pwd`) ;',
    'commit : le sha complet copié de la sortie de `git rev-parse HEAD` lancée juste avant le rapport, jamais retapé, complété ni reconstitué de mémoire ;',
    'headRevParse : la sortie brute de `git rev-parse HEAD`, collée telle quelle ; headLog : la sortie brute de `git log --oneline -1`, collée telle quelle ;',
    'checks (chaque commande lancée, pass, fail ou not-run, nombre de tests) ; scopeCheck (in, out ou not-run) ; outOfScopeFiles ;',
    'reuse : un élément par composant, module ou route créé ou modifié : item (chemin), decision (`reused` ou `extended` avec mapEntry, l\'entrée de la carte du code ; `added` avec justification, pourquoi aucune entrée ne convenait) ; [] si la tâche n\'en crée ni n\'en modifie. Sans cette liste, le rapport est refusé.',
    'placement : un élément par fichier de code créé : file (chemin), folder (son dossier), reason (fonctionnalité, sous-dossier proposé par `' + APV + ' structure check`, convention de la pile) ; [] si la tâche n\'en crée aucun. Sans cette liste, le rapport est refusé.',
    'summary (moins de 300 mots : fichiers principaux, critères couverts et comment, écarts à la maquette ou à la spec et pourquoi) ; openPoints.',
    'N\'annonce aucun résultat que tu n\'as pas observé.',
  ].filter(line => line !== '').join('\n')
}

phase('Implémentation')
log('Lancement (vague ' + WAVE + ') de ' + input.specId + ' : ' + input.tasks.length + ' tâche(s) depuis ' + input.baseCommit)

const reports = await pipeline(input.tasks, task =>
  agent(prompt(task), {
    label: task.id,
    phase: 'Implémentation',
    agentType: 'apv:implementer',
    isolation: 'worktree',
    schema: REPORT,
  }),
)

// The commit of a report is a claim: the three copies of it must agree. The project lead never records it as is:
// it reads the head of the branch with `git rev-parse <branche>` before `apv run set --commit`.
function commitProblems(report) {
  const problems = []
  const commit = typeof report.commit === 'string' ? report.commit.trim() : ''
  const revParse = typeof report.headRevParse === 'string' ? report.headRevParse.trim() : ''
  const oneline = typeof report.headLog === 'string' ? report.headLog.trim() : ''
  if (!/^[0-9a-f]{40,64}$/.test(commit)) problems.push('commit : pas un sha complet')
  if (!revParse) problems.push('headRevParse : sortie brute de git rev-parse HEAD absente')
  else if (revParse !== commit) problems.push('commit différent de la sortie de git rev-parse HEAD')
  if (!oneline) problems.push('headLog : sortie brute de git log --oneline -1 absente')
  else if (!/^[0-9a-f]{7,}/.test(oneline) || !commit.startsWith(oneline.split(/\s/)[0])) problems.push('commit différent du début de git log --oneline -1')
  return problems
}

// Escalation thresholds of the project lead: probable needs a check first, suppose goes to the operator.
const returned = []
const refused = []
const escalation = { verify: [], operator: [] }
input.tasks.forEach((task, index) => {
  const report = reports[index]
  if (!report) return
  const problems = [...claimProblems(report, 'tâche ' + task.id), ...reuseProblems(report, 'tâche ' + task.id), ...placementProblems(report, 'tâche ' + task.id)]
  if (problems.length) return refused.push({ taskId: task.id, problems, report })
  returned.push(report)
  if (report.confidence === 'probable') escalation.verify.push(task.id)
  if (report.confidence === 'suppose') escalation.operator.push(task.id)
})
const commitChecks = input.tasks.map((task, index) => reports[index] ? { taskId: task.id, problems: commitProblems(reports[index]) } : null)
  .filter(check => check && check.problems.length)
if (commitChecks.length) log('Commits incohérents dans les rapports (relire par git rev-parse <branche>) : ' + commitChecks.map(c => c.taskId + ' (' + c.problems.join(' ; ') + ')').join(' | '))
const lost = input.tasks.filter((task, index) => !reports[index]).map(task => task.id)
if (lost.length) log('Sans rapport (agent arrêté ou erreur) : ' + lost.join(', ') + '. À vérifier par apv run next.')
if (refused.length) log('Rapports refusés (confiance) : ' + refused.map(r => r.problems.join(' ; ')).join(' | ') + '. À redemander à l\'agent.')

return {
  specId: input.specId,
  wave: input.wave === undefined ? null : input.wave,
  base: input.base,
  baseCommit: input.baseCommit,
  reports: returned,
  withoutReport: lost,
  refused,
  escalation,
  // Reports whose commit, `git rev-parse HEAD` and `git log --oneline -1` disagree: never recorded as they are.
  commitChecks,
}

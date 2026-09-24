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

const REPORT = {
  type: 'object',
  required: ['taskId', 'status', 'branch', 'worktree', 'commit', 'checks', 'scopeCheck', 'outOfScopeFiles', 'summary', 'openPoints'],
  properties: {
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['done', 'failed', 'wip'] },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    commit: { type: 'string' },
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
    typeof task.extra === 'string' && task.extra ? '- Consigne propre à cette tâche : ' + task.extra : '',
    typeof input.context === 'string' && input.context ? '- Consigne de la vague : ' + input.context : '',
    '',
    '## Fin de tâche',
    '1. Contrôles de tâche au vert : `' + APV + ' gates run --stage task --base ' + input.baseCommit + '` (les contrôles « réservés à la suite complète » ne sont ni lancés ni annoncés verts : le chef de projet passe la suite complète à l\'intégration).',
    '   Tests ciblés : si le tableau montre un contrôle « ciblé » (commande `affected`), il a déjà lancé les tests concernés par tes changements ; ne les relance pas, et ne l\'annonce pas comme la suite complète.',
    '   Sinon, tests navigateur : seulement les fichiers e2e que tu as créés ou modifiés, sous `' + APV + ' lock run e2e -- <commande du projet> <fichiers>` (par exemple `npx playwright test <fichiers>`) ; aucun fichier e2e touché, rien à lancer. Jamais la suite navigateur entière.',
    '   Test instable : répète seulement le test en cause (`<fichier>:<ligne>` ou `-g "<titre>"`), `--repeat-each` 20 au plus, sous le verrou `e2e` ; jamais un fichier entier répété sous le verrou. Cherche d\'abord un clic pendant une animation : attends l\'état stable, pas un délai fixe. Projet à interface : tests navigateur en mouvement réduit par défaut (Playwright `reducedMotion: \'reduce\'`), sauf les tests d\'animation.',
    '   Projet sans contrôle marqué `full` : `--stage task` exécute déjà tout, comme avant. Autres ressources partagées sous bail (`' + APV + ' lock run <ressource> -- <commande>`).',
    '2. Tout est commité sur `' + task.branch + '` ; aucun fichier non commité.',
    '3. `' + APV + ' scope check --spec ' + input.specFile + ' --task ' + task.id + ' --base ' + input.baseCommit + '` : note son résultat et chaque fichier hors périmètre avec sa raison.',
    '4. Ne pousse pas, ne fusionne pas, ne réécris aucun commit.',
    '',
    '## Rapport (sortie structurée)',
    'taskId ; status (`done` si tout est vert et commité, `wip` si le travail est commité mais inachevé, `failed` sinon) ; branch ; worktree (chemin absolu, sortie de `pwd`) ;',
    'commit (sha complet de `git rev-parse HEAD`) ; checks (chaque commande lancée, pass, fail ou not-run, nombre de tests) ; scopeCheck (in, out ou not-run) ; outOfScopeFiles ;',
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

const returned = reports.filter(Boolean)
const lost = input.tasks.filter((task, index) => !reports[index]).map(task => task.id)
if (lost.length) log('Sans rapport (agent arrêté ou erreur) : ' + lost.join(', ') + '. À vérifier par apv run next.')

return {
  specId: input.specId,
  wave: input.wave === undefined ? null : input.wave,
  base: input.base,
  baseCommit: input.baseCommit,
  reports: returned,
  withoutReport: lost,
}

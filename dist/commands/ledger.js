import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { errorMessage } from '../domain/errors.js';
import { Git } from '../execution/git.js';
import { decisionLedgerIssues, ledgerHash, LEDGER_FILE, LEGACY_LEDGER_FILE, decisionLedgerSchema } from '../lifecycle/decisions.js';
import { applyLedgerUpdate, planLedgerUpdate } from '../lifecycle/ledger-update.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
export const usage = `Utilisation :
  apv ledger validate [--repo <chemin>] [--json]
  apv ledger plan --file <mise-a-jour.json> [--repo <chemin>]
  apv ledger apply --file <mise-a-jour.json> --hash <empreinte> --note <texte>
                   [--reviewer <nom>] [--commit] [--repo <chemin>]

Registre des décisions : .apv/DECISIONS.json, ou .agent-pipeline/DECISIONS.json pour un projet V2.
validate liste toutes les erreurs ; plan affiche le registre obtenu et son empreinte ;
apply écrit exactement le plan relu (même empreinte), et le commite avec --commit.`;
function readJson(path) {
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch (error) {
        throw new UsageError(`fichier illisible : ${errorMessage(error)}`);
    }
    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw new UsageError(`JSON invalide dans ${path} : ${errorMessage(error)}`);
    }
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, {
            repo: { type: 'string' }, file: { type: 'string' }, hash: { type: 'string' }, note: { type: 'string' },
            reviewer: { type: 'string' }, commit: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
        });
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        const [action, ...rest] = positionals;
        if (rest.length)
            throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
        const repo = repoPath(io, values.repo);
        if (action === 'validate') {
            const file = [LEDGER_FILE, LEGACY_LEDGER_FILE].find(f => existsSync(join(repo, f))) ?? null;
            if (!file) {
                if (values.json)
                    json(io, { valid: true, file: null, decisions: 0, issues: [] });
                else
                    io.stdout(`Aucun registre dans ${repo} (${LEDGER_FILE} ni ${LEGACY_LEDGER_FILE}) : registre vide.\n`);
                return EXIT.ok;
            }
            let issues;
            let raw;
            try {
                raw = JSON.parse(readFileSync(join(repo, file), 'utf8'));
                issues = decisionLedgerIssues(raw);
            }
            catch (error) {
                issues = [{ code: 'JSON', message: `JSON invalide : ${errorMessage(error)}` }];
            }
            const valid = issues.length === 0;
            const ledger = valid ? decisionLedgerSchema.parse(raw) : null;
            if (values.json)
                json(io, { valid, file, decisions: ledger?.decisions.length ?? null, hash: ledger ? ledgerHash(ledger) : null, issues });
            else if (valid)
                io.stdout(`Registre valide : ${file} (${ledger.decisions.length} décision(s), empreinte ${ledgerHash(ledger)})\n`);
            else
                io.stdout(`Registre invalide : ${file}\n${issues.length} erreur(s) :\n${issues.map(i => `- [${i.code}] ${i.message}`).join('\n')}\n`);
            return valid ? EXIT.ok : EXIT.failed;
        }
        if (action === 'plan' || action === 'apply') {
            if (!values.file)
                throw new UsageError('--file manquant');
            const update = readJson(resolve(io.cwd, values.file));
            if (action === 'plan') {
                const plan = await planLedgerUpdate(repo, update);
                json(io, { ...plan, next: `apv ledger apply --repo ${plan.repo} --file ${values.file} --hash ${plan.hash} --note "raison" --commit` });
                return EXIT.ok;
            }
            if (!values.hash)
                throw new UsageError('--hash manquant : relisez d\'abord le plan (apv ledger plan)');
            if (!values.note)
                throw new UsageError('--note manquant : expliquez la modification du registre');
            const reviewer = values.reviewer ?? await new Git().configValue(repo, 'user.name');
            if (!reviewer)
                throw new UsageError('--reviewer manquant (et aucun user.name Git)');
            const applied = await applyLedgerUpdate(repo, update, values.hash, reviewer, values.note, values.commit === true);
            json(io, { applied: true, file: applied.file, added: applied.added, superseded: applied.superseded, ledgerHash: applied.ledgerHash, commitSha: applied.commitSha });
            return EXIT.ok;
        }
        throw new UsageError(action ? `sous-commande inconnue : ledger ${action}` : 'sous-commande manquante');
    });
}
//# sourceMappingURL=ledger.js.map
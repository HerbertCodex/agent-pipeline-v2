import { taskSchema } from '../domain/contracts.js';
import { invariant } from '../domain/errors.js';
import { sensitivePaths, matches, validRelativePath } from '../policy/policy.js';
import { assessSecurity } from '../security/owasp.js';
import { specSchema } from './contracts.js';
/** Explicit compact input is already a scoped task. No paid Product or Design round is needed.
 * Normal spec validation, decision coverage, approval, risk escalation and gates still apply.
 */
export function compactProposal(input, request, config) {
    const task = taskSchema.parse(input);
    const security = assessSecurity({ text: `${request}\n${task.title}\n${task.description}\n${task.acceptance.join('\n')}`, files: task.allowedPaths, projectType: config.skills.projectType });
    invariant(task.allowedPaths.length <= 8 && task.allowedPaths.every(p => validRelativePath(p) && !/[*?]/.test(p) && !sensitivePaths.some(g => matches(p, g)) && !config.risk.highPaths.some(g => matches(p, g))) && !task.allowedNewPaths.length, 'COMPACT_SCOPE', 'Compact mode requires at most eight explicit, non-sensitive paths; use spec draft for broader work');
    invariant(task.minimumLane !== 'high' && security.minimumLane !== 'high' && !security.negativeTestsRequired && !security.requiresThreatModel &&
        !/\b(migrat\w*|architectur\w*|redesign|refonte|public (?:api|interface)|breaking change)\b/i.test(`${request} ${task.description}`), 'COMPACT_SCOPE', 'Structural or sensitive work requires a standard Product spec');
    const lane = task.allowedPaths.every(p => /(?:\.md|\.txt)$/.test(p)) && !security.topics.length ? 'fast' : 'standard';
    const checks = config.gates.filter(g => g.mandatory || g.lanes.includes(lane)).map(g => g.id).join(', ');
    const acceptance = task.acceptance.map((description, i) => ({ id: `AC-${i + 1}`, description,
        verification: `Observe this behavior in a focused test or review the resulting diff. Configured checks: ${checks}.` }));
    return specSchema.parse({ title: task.title, problem: task.description.length >= 10 ? task.description : `${task.title}: ${task.description}`,
        scope: [task.description], outOfScope: ['Architecture changes, dependency changes and new security behavior.'],
        acceptance, decisions: [], questions: [], minimumLane: lane,
        tasks: [{ id: task.id, title: task.title, description: task.description, allowedPaths: task.allowedPaths, dependsOn: [], minimumLane: lane, acceptanceIds: acceptance.map(a => a.id) }],
        experience: { uiImpact: security.profile.webUi ? 'minor' : 'none', surfaces: security.profile.webUi ? task.allowedPaths : [], rationale: 'Bounded change within existing components and established visual conventions.' },
        security: { profile: security.profile, owaspTopics: security.topics.map(t => t.id), requirements: security.topics.map((topic, i) => ({
                id: `SEC-${i + 1}`, title: `Preserve existing ${topic.id} controls`, owaspTopics: [topic.id], acceptanceIds: acceptance.map(a => a.id),
                verification: `Review the changed paths for regressions in ${topic.id}; inspect the configured check results. Escalate new security behavior to a standard spec.`, negativeTests: [],
            })) },
    });
}
//# sourceMappingURL=compact.js.map
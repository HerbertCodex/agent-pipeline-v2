import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,approved,oneTask} from './lifecycle-helpers.mjs';
import {specSchema} from '../dist/lifecycle/contracts.js';

test('legacy review cases require hash approval and preserve the original spec, candidate and history', async t=>{
 const f=fixture(t);f.config.workflow.qaLanes=[];
 const spec=specSchema.parse(oneTask());
 const topic=specSchema.json.properties.security.properties.requirements.items.properties.owaspTopics.items.enum[0];
 spec.security.requirements=[{id:'SEC-SUPPLY',title:'Unchanged dependencies',owaspTopics:[topic],acceptanceIds:['AC-MATH'],verification:'Inspect the final diff for unexpected dependency changes.',negativeTests:['Confirm by review that the dependency manifest is unchanged.','Reject invalid input without changing state.']}];
 let doc=await approved(f,spec);doc=await f.life.run(doc.id);
 assert.equal(doc.data.error,null);
 const before=structuredClone(doc.data);
 const criterion=doc.data.content.acceptance[0];
 const correction={description:criterion.description,verification:criterion.verification,reason:'This legacy case explicitly asks for source inspection rather than an executed test.',requirements:[{id:'SEC-SUPPLY',verification:spec.security.requirements[0].verification,reviewTestIndexes:[0]}]};
 assert.throws(()=>f.life.planCriterionAmendment(doc.id,criterion.id,{...correction,requirements:[{...correction.requirements[0],reviewTestIndexes:[2]}]}),/distinct existing/);
 doc=f.life.planCriterionAmendment(doc.id,criterion.id,correction);
 const change=doc.data.criterionAmendments.at(-1);
 assert.equal(change.requirements[0].reviewTests[0].previous,spec.security.requirements[0].negativeTests[0]);
 assert.equal(f.life.approved(doc.data).security.requirements[0].negativeTests[0],spec.security.requirements[0].negativeTests[0]);
 assert.throws(()=>f.life.approveCriterionAmendment(doc.id,change.id,'wrong','Owner','Approved inspection for this legacy case.'),/exact corrected/);
 doc=f.life.approveCriterionAmendment(doc.id,change.id,change.hash,'Owner','Approved inspection for this legacy case.');
 const effective=f.life.approved(doc.data);
 assert.equal(effective.security.requirements[0].negativeTests[0],'[review] '+spec.security.requirements[0].negativeTests[0]);
 assert.equal(effective.security.requirements[0].negativeTests[1],spec.security.requirements[0].negativeTests[1]);
 assert.deepEqual(doc.data.content,before.content);
 assert.deepEqual(doc.data.attempts,before.attempts);
 assert.equal(doc.data.currentSha,before.currentSha);
 assert.equal(doc.data.contentHash,before.contentHash);
 assert.equal(doc.data.qa,null);
 assert.equal(doc.data.review,null);
 assert.throws(()=>f.life.planCriterionAmendment(doc.id,criterion.id,correction),/already permits review/);

 // Upstream full-list amendments and local index amendments must compose.
 const negativeTests=[...effective.security.requirements[0].negativeTests];
 negativeTests[1]='[review] '+negativeTests[1];
 doc=f.life.planCriterionAmendment(doc.id,criterion.id,{...correction,requirements:[{id:'SEC-SUPPLY',verification:correction.requirements[0].verification,negativeTests}]});
 const fullListChange=doc.data.criterionAmendments.at(-1);
 doc=f.life.approveCriterionAmendment(doc.id,fullListChange.id,fullListChange.hash,'Owner','Approve both inspections for this unchanged dependency requirement.');
 assert.deepEqual(f.life.approved(doc.data).security.requirements[0].negativeTests,negativeTests);

 doc=f.life.planCriterionAmendment(doc.id,criterion.id,{...correction,requirements:[{id:'SEC-SUPPLY',verification:'Inspect the final candidate diff and dependency manifest for unexpected changes.'}]});
 const verificationChange=doc.data.criterionAmendments.at(-1);
 doc=f.life.approveCriterionAmendment(doc.id,verificationChange.id,verificationChange.hash,'Owner','Clarify the inspection without changing its approved cases.');
 assert.deepEqual(f.life.approved(doc.data).security.requirements[0].negativeTests,negativeTests);
 assert.deepEqual(doc.data.content,before.content);
 assert.equal(doc.data.currentSha,before.currentSha);
});

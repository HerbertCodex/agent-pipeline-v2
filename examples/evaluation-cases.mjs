// Small engineering cases with fixed acceptance oracles. No provider calls at import time.
export const evaluationCases = [
  {
    id: 'boundary-fix', category: 'local-bug', path: 'src/range.mjs',
    request: 'Fix clamp(value,min,max) to keep values within inclusive bounds. Reject inverted bounds with RangeError. Reuse the existing exported function; preserve its signature.',
    before: 'export const clamp = (value, min, max) => Math.max(value, max);\n',
    checks: "assert.equal(mod.clamp(3,0,5),3); assert.equal(mod.clamp(-1,0,5),0); assert.equal(mod.clamp(8,0,5),5); assert.equal(mod.clamp(5,5,5),5); assert.throws(()=>mod.clamp(2,5,1),RangeError);",
  },
  {
    id: 'small-feature', category: 'feature', path: 'src/page.mjs',
    request: 'Implement page(items,offset,limit): return a new slice without mutating input; allow zero limit; reject negative or noninteger offset/limit with RangeError. Keep the exported function and existing module boundary.',
    before: 'export const page = (items, offset, limit) => items;\n',
    checks: "const items=[1,2,3,4]; assert.deepEqual(mod.page(items,1,2),[2,3]); assert.deepEqual(mod.page(items,1,0),[]); assert.deepEqual(items,[1,2,3,4]); assert.notEqual(mod.page(items,0,4),items); for(const [o,l] of [[-1,2],[0,-1],[0.5,1],[0,1.5]]) assert.throws(()=>mod.page(items,o,l),RangeError);",
  },
  {
    id: 'async-failure', category: 'integration-boundary', path: 'src/retry.mjs',
    request: 'Implement retry(operation,maxAttempts): await operation; retry only errors with transient===true, never beyond maxAttempts. Return the successful value or throw the last error unchanged. Reject nonpositive or noninteger maxAttempts with RangeError. No sleeps or network needed; keep the injected operation boundary.',
    before: 'export async function retry(operation, maxAttempts) { return operation(); }\n',
    checks: "let n=0; const transient=Object.assign(new Error('temporary'),{transient:true}); assert.equal(await mod.retry(async()=>{if(++n<3) throw transient; return 7;},3),7); assert.equal(n,3); n=0; await assert.rejects(mod.retry(async()=>{n++;throw transient;},2),e=>e===transient); assert.equal(n,2); n=0; const permanent=new Error('permanent'); await assert.rejects(mod.retry(async()=>{n++;throw permanent;},4),e=>e===permanent); assert.equal(n,1); await assert.rejects(mod.retry(async()=>1,0),RangeError);",
  },
  {
    id: 'ui-state', category: 'minor-ui', path: 'src/notice.mjs',
    request: 'Update renderNotice(text,busy=false) within the existing visual convention. Return a paragraph with class notice, role status and aria-busy as true/false. Encode ampersand, less-than and greater-than in text, treating text as untrusted content. Preserve the function boundary; no new framework or styling system.',
    before: 'export const renderNotice = (text, busy=false) => `<p class="notice">${text}</p>`;\n',
    checks: "assert.equal(mod.renderNotice('Ready'),'<p class=\"notice\" role=\"status\" aria-busy=\"false\">Ready</p>'); assert.equal(mod.renderNotice('<b>&</b>',true),'<p class=\"notice\" role=\"status\" aria-busy=\"true\">&lt;b&gt;&amp;&lt;/b&gt;</p>');",
  },
  {
    id: 'authorization', category: 'sensitive', path: 'src/auth/access.mjs',
    request: 'Fix canRead(actor,document) for tenant isolation. Deny null or malformed inputs. Permit only matching nonempty string tenantId and either matching nonempty actor.id/document.ownerId or actor.role exactly admin. Tenant mismatch must always deny, including admins. Do not mutate inputs or change the API.',
    before: "export const canRead = (actor, document) => actor?.role === 'admin' || actor?.id === document?.ownerId;\n",
    checks: "const d={tenantId:'t1',ownerId:'u1'}; assert.equal(mod.canRead({id:'u1',tenantId:'t1'},d),true); assert.equal(mod.canRead({id:'u2',tenantId:'t1',role:'admin'},d),true); assert.equal(mod.canRead({id:'u1',tenantId:'t2',role:'admin'},d),false); for(const a of [null,{}, {id:'u2',tenantId:'t1'}, {id:'u1',tenantId:''}]) assert.equal(mod.canRead(a,d),false); assert.equal(mod.canRead({},{}),false); assert.equal(mod.canRead(null,null),false);",
  },
  {
    id: 'schema-evolution', category: 'structural', path: 'src/migrations/upgrade.mjs',
    request: 'Implement pure upgrade(record) for a versioned data contract. For version 1 records, return a new version 2 record preserving id and other fields, moving fullName into displayName and removing fullName. A version 2 record remains semantically unchanged. Unknown versions throw RangeError. Never mutate input; preserve the exported boundary and avoid migration frameworks.',
    before: 'export const upgrade = record => record;\n',
    checks: "const old={version:1,id:'1',fullName:'Ada',active:true}; const next=mod.upgrade(old); assert.deepEqual(next,{version:2,id:'1',displayName:'Ada',active:true}); assert.equal(old.fullName,'Ada'); assert.equal(old.version,1); assert.deepEqual(mod.upgrade(next),next); assert.throws(()=>mod.upgrade({version:3}),RangeError);",
  },
];

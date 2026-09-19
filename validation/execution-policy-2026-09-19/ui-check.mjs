// Offline browser fixture: no provider calls or live pipeline store.
// Requires an existing Playwright installation and Chromium executable.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(process.env.UI_VALIDATION_OUTPUT || '/tmp/apv2-execution-policy-ui'); mkdirSync(output, {recursive:true});
const raw = 'qa failed: the provider stopped it at its cost ceiling (agent.maxBudgetUsd); spent: 22 turns, 3.18 USD declared by the provider (exit 1) after 437757 ms: qa failed ' + JSON.stringify({duration_api_ms:220660, modelUsage:{'claude-opus-5':{outputTokens:33849}}, diagnostics:'x'.repeat(16000), markup:'<img src=x onerror="window.injected=true">'});
const decisions = [
  'Add a minimal shared module `src/lib/server/pagination/index.ts` exporting `PAGE_SIZE = 25`, a `parsePageParam(raw)` that clamps anything not a positive integer to 1, and a small `paginate(totalItems, page)` helper returning `{ page, pageSize, totalItems, totalPages, offset }`. Every paginated list calls this helper once and appends its own `LIMIT ? OFFSET ?` to its existing SQL.',
  'Move the catalogue sort from JavaScript into SQL ORDER BY so LIMIT/OFFSET can be applied at the query level, with books.id as the tie-breaker for a total order and the collation gap documented.',
  'Clamp invalid or out-of-range page values to a valid page, preserving filters and consistent navigation links.',
  'Use a namespaced rendus parameter for the history list and preserve the active-loan list independently.',
  'Add one exported wrapper in `src/lib/server/retention/index.ts`, wrapping the existing purge and error-reporting sequence. The three call sites each preserve their existing message.',
  'Move the startup purge out of top-level module evaluation in `hooks.server.ts` into the SvelteKit `init` hook to prevent execution during tools that import the module.'
];
const summary = {id:'readability',title:'Pagination serveur des cinq listes + trois corrections QA incrément 3',repo:'/home/operator/project-test',status:'blocked',error:{code:'ROLE',message:raw},questions:[],tasks:[],activeMs:437757,planningMs:180000,executionPath:'structural',architecture:{summary:'Six structural decisions for the pagination increment. '+decisions.join(' '),decisions:decisions.map(decision=>({decision,rationale:'The operator requires true server-side pagination across five list surfaces. Reusing one helper prevents semantic drift between routes and avoids repeated parsing logic.',constraint:'Only the requested page is read and rendered. Existing filters and access checks must be preserved.',simplerAlternative:'Keep the current query structure and introduce only the helper that the five routes share.',alternatives:['A generic route wrapper was considered, but cannot cleanly express independent lists on the same route.'],tradeoffs:['One small shared module and its tests, in exchange for consistent semantics across routes.'],risks:['SQL collation may differ from JavaScript sorting for accents and numeric strings.'],reconsiderWhen:['A list needs cursor-based pagination or a different page size.']}))}};
summary.timing={phases:[{phase:'product',durationMs:25000},{phase:'qa',durationMs:60000}],preflightMs:1000,active:[],historicalPartial:false};
summary.models=['product','design','implementer','qa'].flatMap(role=>['standard','high'].map(lane=>({role,lane,effectiveLane:role==='qa'?'high':lane,provider:'claude',model:role==='qa'?'qa-pinned':'impl-pinned',effort:'high',source:'roleProfiles.deep',usageMode:'legacy',decision:{policyVersion:'execution-policy-1',reasons:['dedicated-qa-policy','explicit-model']}})));
let lastBudget=null;
const detail = {summary,repo:summary.repo,busy:false,approval:{hash:'approved'},content:{problem:'Les cinq listes doivent paginer côté serveur en conservant les filtres et les contrôles d’accès.',scope:['Pagination des cinq listes.'],outOfScope:['Aucune nouvelle dépendance.'],tasks:[],acceptance:[],minimumLane:'standard'},scopeAmendments:[],criterionAmendments:[],validations:[{state:'ready'}],attempts:[],impactAdvice:[],request:'Paginer les listes.',cost:{knownUsd:3.18,budget:{knownUsd:3.18},ceilingUsd:25,configuredCeilingUsd:25}};
const server = createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(req.method==='POST' && url.pathname==='/api/specs/readability/budget'){
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{lastBudget=JSON.parse(body);res.writeHead(200,{'content-type':'application/json'});res.end('{}');});return;
 }
 const payloads={'/api/session':{csrf:'fixture',stateDir:'/tmp/fixture'},'/api/specs':[summary],'/api/jobs':[], '/api/specs/readability':detail,'/api/specs/readability/events':[]};
 if(url.pathname==='/api/stream'){res.writeHead(200,{'content-type':'text/event-stream'});res.end();return;}
 if(url.pathname in payloads){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(payloads[url.pathname]));return;}
 const files={'/':'index.html','/app.js':'app.js','/app.css':'app.css'};
 const name=files[url.pathname]; if(!name){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'content-type':name.endsWith('css')?'text/css':name.endsWith('js')?'text/javascript':'text/html'});res.end(readFileSync(`${root}/ui/${name}`));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,headless:true,args:['--no-sandbox']});
const results=[];
try {
 for(const [width,height,theme] of [[1440,1000,'dark'],[1024,900,'dark'],[390,844,'dark'],[320,740,'light']]){
  const context=await browser.newContext({viewport:{width,height},colorScheme:theme, permissions:['clipboard-read','clipboard-write']});const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/#readability`);
  await page.locator('.architecture__decision').first().waitFor();
  assert.equal(await page.locator('.architecture__decision').count(),6);
  assert.equal(await page.locator('.diagnostic__details').getAttribute('open'),null);
  assert.match(await page.locator('.decision__title').innerText(),/QA a atteint son plafond/);
  assert.match(await page.locator('.diagnostic__summary').innerText(),/22 tours.*7 min 18.*3,18/);
  const measure=()=>page.evaluate(()=>({page:document.documentElement.scrollWidth,viewport:innerWidth,main:document.querySelector('#main').scrollWidth,mainClient:document.querySelector('#main').clientWidth}));
  let dims=await measure(); assert.ok(dims.page<=width+1&&dims.main<=dims.mainClient+1,JSON.stringify({width,...dims}));
  await page.screenshot({path:`${output}/${width}-${theme}-closed.png`,fullPage:true});
  const errorToggle=page.locator('.diagnostic__details > summary');await errorToggle.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('.diagnostic__details').open);
  assert.equal(await page.locator('.diagnostic__raw').textContent(),'ROLE — '+raw);
  assert.ok((await page.locator('.diagnostic__raw').boundingBox()).height<=280);
  assert.equal(await page.locator('.diagnostic img').count(),0);
  await page.locator('.architecture__summary').first().click();
  await page.waitForFunction(()=>document.querySelector('.architecture__decision').open);
  assert.equal(await page.locator('.architecture__choice').first().textContent(),decisions[0].replace(/`/g,''));
  assert.equal(await page.locator('.architecture__field dt').first().textContent(),'Pourquoi ce choix');
  await page.waitForTimeout(50);await page.evaluate(()=>renderDetail());
  assert.equal(await page.locator('.architecture__decision').first().getAttribute('open'),'');
  assert.equal(await page.locator('.diagnostic__details').getAttribute('open'),'');
  dims=await measure();assert.ok(dims.page<=width+1&&dims.main<=dims.mainClient+1,JSON.stringify({width,open:true,...dims}));
  await page.locator('.architecture').scrollIntoViewIfNeeded();
  await page.screenshot({path:`${output}/${width}-${theme}-open.png`,fullPage:true});
  await page.getByRole('button',{name:'Copier le diagnostic'}).click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'ROLE — '+raw);
  const fallback = await page.evaluate(() => {
    const node = errorDiagnostic({code:'OTHER',message:'Unexpected failure '+ 'x'.repeat(3000) + ' {"private":"data"}'}, 'unknown');
    return {summary:node.querySelector('.diagnostic__summary').textContent, raw:node.querySelector('pre').textContent};
  });
  assert.ok(fallback.summary.length<=281 && !fallback.summary.includes('private') && fallback.raw.includes('private'));
  const contrast = await page.evaluate(() => {
    const css=getComputedStyle(document.documentElement);
    const luminance=hex=>{const rgb=hex.trim().slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};
    const fg=luminance(css.getPropertyValue('--ink-3'));
    return ['--bg','--panel'].map(token=>{const bg=luminance(css.getPropertyValue(token));return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);});
  });
  assert.ok(contrast.every(value=>value>=4.5),JSON.stringify({theme,contrast}));

  await page.getByText('Temps par étape',{exact:true}).click();
  assert.match(await page.locator('details').filter({hasText:'Temps par étape'}).innerText(),/QA : 60.0 s/);
  await page.getByText('Modèles choisis par rôle',{exact:true}).click();
  assert.ok((await page.locator('.model-choice__reason').first().innerText()).includes('execution-policy-1'));
  await page.getByRole('button',{name:'Ajuster les limites',exact:true}).click();
  for(const role of ['product','design','implementer','qa']) await page.getByLabel(new RegExp(`^${role} — mode d’usage`)).selectOption('subscription');
  await page.getByLabel('Plafond total hors abonnement en dollars (vide : désactivé)',{exact:true}).fill('');
  await page.getByLabel('Motif',{exact:true}).fill('Migration abonnement pour cette spec');
  const dialogDims=await page.locator('#dialog').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
  assert.ok(dialogDims.scroll<=dialogDims.width+1,JSON.stringify({width,...dialogDims}));
  await page.screenshot({path:`${output}/${width}-${theme}-settings.png`,fullPage:true});
  await page.getByRole('button',{name:'Enregistrer',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#dialog').open);
  assert.equal(lastBudget.limits.maxSpecCostUsd,null);
  for(const role of ['product','design','implementer','qa']) assert.deepEqual(lastBudget.limits.roles[role],{usageMode:'subscription'});

  assert.deepEqual(errors,[]);
  results.push({width,height,theme,overflow:false,keyboard:true,fullDiagnostic:true,preservedDisclosure:true,clipboard:true,subscriptionForm:true,nullBudget:true,preservedModels:true,phaseTiming:true,contrast,errors});
  await context.close();
 }
 writeFileSync(`${output}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
} finally {await browser.close();server.close();server.closeAllConnections();}

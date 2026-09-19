// Offline UI fixture. Uses an existing Playwright/Chromium install; no provider calls.
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.env.UI_VALIDATION_OUTPUT || '/tmp/apv2-qa-cleanup-ui';
mkdirSync(output, { recursive:true });
const summary = { id:'cleanup', title:'Nettoyage après pagination', repo:'/tmp/fixture', status:'blocked',
  error:{code:'QA_REJECTED',message:'Required cleanup remains.'}, questions:[], tasks:[], activeMs:1000 };
const detail = { summary, repo:summary.repo, busy:false, content:{problem:'Pagination',scope:[],outOfScope:[],tasks:[],acceptance:[]},
  scopeAmendments:[],criterionAmendments:[],validations:[],attempts:[],impactAdvice:[],
  qa:{ report:{candidateSha:'a'.repeat(40),verdict:'changes_requested',summary:'Un helper est devenu inutilisé.',criteria:[],
    findings:[{id:'CLEAN',severity:'minor',resolution:'required',path:'src/catalogue/index.ts',description:'Helper devenu inutilisé après le passage au tri SQL.'},
      {id:'OLD',severity:'minor',resolution:'advisory',path:'docs/old.md',description:'Observation ancienne sans rapport avec la pagination.'},
      {id:'MAJOR',severity:'major',resolution:'advisory',path:'src/loans.ts',description:'Un défaut majeur reste obligatoire même si sa résolution est mal étiquetée.'}] } } };
const server = createServer((req,res)=>{
  const url = new URL(req.url,'http://localhost');
  if(url.pathname==='/api/stream'){res.writeHead(200,{'content-type':'text/event-stream'});res.end();return;}
  const payloads = {'/api/session':{csrf:'fixture',stateDir:'/tmp/fixture'},'/api/specs':[summary],'/api/jobs':[],
    '/api/specs/cleanup':detail,'/api/specs/cleanup/events':[]};
  if(url.pathname in payloads){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(payloads[url.pathname]));return;}
  const file = {'/':'index.html','/app.js':'app.js','/app.css':'app.css'}[url.pathname];
  if(!file){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':file.endsWith('css')?'text/css':file.endsWith('js')?'text/javascript':'text/html'});
  res.end(readFileSync(`${root}/ui/${file}`));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,headless:true,args:['--no-sandbox']});
  const results=[];
  for(const [width,height] of [[1440,1000],[390,844]]){
    const page=await browser.newPage({viewport:{width,height}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/#cleanup`);
    await page.getByRole('tab',{name:/^QA/}).click();
    await page.getByText('Helper devenu inutilisé après le passage au tri SQL.',{exact:true}).waitFor();
    assert.equal(await page.getByText('Correction requise',{exact:true}).count(),2);
    assert.equal(await page.getByText('Observation',{exact:true}).count(),1);
    const dims=await page.evaluate(()=>({width:innerWidth,page:document.documentElement.scrollWidth,main:document.querySelector('#main').scrollWidth,client:document.querySelector('#main').clientWidth}));
    assert.ok(dims.page<=width+1&&dims.main<=dims.client+1,JSON.stringify(dims));
    assert.deepEqual(errors,[]);
    await page.screenshot({path:`${output}/${width}.png`,fullPage:true});
    results.push({width,height,requiredMinor:true,majorCannotBeAdvisory:true,advisoryDistinct:true,overflow:false,errors});
    await page.close();
  }
  writeFileSync(`${output}/results.json`,JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results));
} finally {await browser?.close();server.close();server.closeAllConnections();}

// A deterministic fixture worker, NOT an AI. This file exists solely to make the
// complete pipeline demonstrable without credentials, network, or model charges.
import {readFileSync,writeFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8'));
if(request.protocol!=='agent-pipeline/v2' || request.task.id!=='DEMO-ADD') throw new Error('This worker only accepts the demo fixture.');
writeFileSync('src/math.mjs','export const add = (a, b) => a + b;\n');
console.log(JSON.stringify({summary:'Fixture déterministe : la soustraction a été remplacée par une addition.'}));

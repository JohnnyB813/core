import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {boundedJson, endpoint} from '../shared/http.ts';
import {assess, parseHead, parseHash} from '../shared/health.ts';
import {probe} from '../shared/probe.ts';
import type {Policy} from '../shared/health.ts';
const config=JSON.parse(await readFile(process.argv[2]||new URL('../.local/operator-trial.json',import.meta.url),'utf8')) as {candidate:string;reference:string;policy:Policy;leaseId:string;imageDigest:string};
const output:Record<string,unknown>={checkedAt:new Date().toISOString(),candidate:config.candidate,reference:config.reference,leaseId:config.leaseId,imageDigest:config.imageDigest};
try {
  const [observation,reference] = await Promise.all([
    probe(config.candidate,config.policy.checkpoint),
    boundedJson(endpoint(config.reference).origin+'/chain/head').then(parseHead)
  ]);
  const referenceCheckpoint=parseHash(await boundedJson(endpoint(config.reference).origin+'/chain/block/'+config.policy.checkpoint.height+'/hash'));
  if(referenceCheckpoint!==config.policy.checkpoint.hash) throw new Error('Independent reference checkpoint mismatch');
  output.observation=observation; output.referenceHead=reference;
  output.assessment=assess(observation,reference.height,Date.now(),config.policy);
}catch(error){output.assessment={healthy:false,reason:'probe-failed'};output.error=String(error);}
await mkdir(new URL('../evidence/',import.meta.url),{recursive:true});
await writeFile(new URL('../evidence/preflight-latest.json',import.meta.url),JSON.stringify(output,null,2));
console.log(JSON.stringify(output,null,2));

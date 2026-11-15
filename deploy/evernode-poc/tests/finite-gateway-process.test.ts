import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {request as httpsRequest} from 'node:https';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {parseExperimentPlan} from '../runtime/experiment.ts';
import {signFinite} from '../fault/finite-install.ts';
import {signControl} from '../fault/protocol.ts';
const fixture=JSON.parse(await readFile('tests/runtime-secrets.json','utf8')) as {contractId:string;operator:string};
const operator=JSON.parse(await readFile('deploy/fault-operator.json','utf8')) as {operatorPublicKey:string};
const ca=await readFile('/contract/cfg/tlscert.pem');
async function request(path:string,body?:unknown,signature?:string,port=9445):Promise<{status:number;body:unknown}>{return new Promise((resolve,reject)=>{const data=body?JSON.stringify(body):undefined,req=httpsRequest({hostname:'127.0.0.1',port,path,method:data?'POST':'GET',ca,rejectUnauthorized:true,agent:false,headers:{...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),...(signature?{'x-pilot-signature':signature}:{})}},r=>{const chunks:Buffer[]=[];r.on('data',c=>chunks.push(c));r.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({status:r.statusCode!,body:text[0]==='{'?JSON.parse(text):text});});});req.on('error',reject);req.setTimeout(2000,()=>req.destroy(new Error('Fixture deadline')));req.end(data);});}
async function until<T>(probe:()=>Promise<T>,accept:(value:T)=>boolean){const deadline=Date.now()+15000;while(Date.now()<deadline){try{const value=await probe();if(accept(value))return value;}catch{}await delay(50);}throw new Error('Finite gateway fixture deadline');}
test('G2 installs a finite plan, exposes safe evidence and keeps its controller alive while the proxy is paused',{timeout:45000},async t=>{
  const child=spawn(process.execPath,['runtime/main.ts'],{env:{...process.env,PILOT_RUNTIME:'gateway',ROLE:'g2',INTERNAL_USER_PORT:'9445'},stdio:['ignore','pipe','pipe']});let logs='';for(const stream of [child.stdout,child.stderr])stream?.on('data',c=>{logs=(logs+c.toString()).slice(-32768);});
  t.after(async()=>{if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');spawnSync('/bin/kill',['-TERM',String(child.pid)],{uid:1000,gid:1000,stdio:'ignore'});assert.equal(await Promise.race([exited.then(()=>true),delay(12000,false,{ref:false})]),true);});
  try{
    const initial=await until(()=>request('/pilot/status'),r=>r.status===200&&(r.body as {observations:{applicationRunning:boolean}}).observations.applicationRunning),status=initial.body as {generation:string};
    assert.equal((await request('/pilot/canary')).status,404);assert.equal((await request('/pilot/experiment')).status,200);
    const from=Date.now()+60000,targets=['c1','c2','c3','c4','c5','w1','w2','w3','g1','g2'].map((id,i)=>({id,ip:'203.0.113.'+(i+1),controlOrigin:'https://'+id+'.example:30001',apiOrigin:id[0]==='c'?null:'https://'+id+'.example:30001',generation:id==='g2'?status.generation:randomUUID()})),raw={version:1,contractId:fixture.contractId,runId:randomUUID(),runnerId:'g2',notBefore:from,expiresAt:from+1200000+21600000+20000,offline:{from:from+1200000,to:from+4800000},soak:{from:from+1200000,to:from+1200000+21600000},performance:{from,durationMs:900000,requestsPerSecond:10},config:{contractId:fixture.contractId,controllers:['c1','c2','c3','c4','c5'],controllerEndpoints:[1,2,3,4,5].map(i=>({id:'c'+i,url:'wss://c'+i+'.example:31001/',serverKey:'ed'+String(i).repeat(64)})),backends:targets.filter(t=>t.id[0]==='w').map(t=>({id:t.id,url:t.apiOrigin})),reference:'https://reference.example',policy:{checkpoint:{height:5000000,hash:'a'.repeat(64)},minimumHeight:5000000,maxLag:3,minPeers:2,maxLatencyMs:3000,freshnessMs:30000}},targets,actions:[],checks:[{id:'healthy',from,to:from+60000,api:'available',quorum:'present',excludedWorkers:[]}]},parse=(raw:unknown)=>parseExperimentPlan(raw,operator.operatorPublicKey),payload=parse(raw),command={version:1 as const,contractId:fixture.contractId,targetId:'g2' as const,generation:status.generation,operationId:randomUUID(),issuedAt:Date.now(),payload};
    assert.equal((await request('/pilot/experiment',command,'a'.repeat(88))).status,403);
    assert.equal((await request('/pilot/experiment',command,signFinite('offsite-experiment',command,parse,fixture.operator))).status,200);
    const installed=await until(()=>request('/pilot/experiment'),r=>r.status===200&&(r.body as {progress?:unknown}).progress!==null);
    assert.doesNotMatch(JSON.stringify(installed.body),/"actions"\s*:\s*\[/);assert.doesNotMatch(JSON.stringify(installed.body),/PRIVATE KEY|"payload"/);
    const dashboard=await request('/pilot/dashboard');assert.equal(dashboard.status,200);assert.match(String(dashboard.body),/Download measured observations/);
    await until(()=>request('/status',undefined,undefined,8443),r=>r.status===200);
    const control={version:1 as const,contractId:fixture.contractId,targetId:'g2',generation:status.generation,operationId:randomUUID(),action:'pause' as const,issuedAt:Date.now(),durationMs:1000};assert.equal((await request('/pilot/control',control,signControl(control,fixture.operator))).status,200);
    assert.equal((await request('/pilot/experiment')).status,200);assert.equal((await request('/pilot/dashboard')).status,200);
    await until(()=>request('/status',undefined,undefined,8443),r=>r.status===200);
  }catch(e){console.error(logs.split('\n').filter(l=>!/secret|private.?key|ed[0-9a-f]{128}/i.test(l)).join('\n'));throw e;}
});

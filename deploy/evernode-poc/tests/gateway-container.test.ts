import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {Server} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {parseConfig,haproxyConfig} from '../gateway/config.ts';
import {fixture,head,hash} from './helpers.ts';
const policy={checkpoint:{height:5000000,hash},minimumHeight:5000000,maxLag:3,minPeers:2,maxLatencyMs:3000,freshnessMs:30000};
async function close(server:Server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');await once(child,'exit');}
async function eventually<T>(operation:()=>Promise<T>,accept:(value:T)=>boolean,timeoutMs=5000):Promise<T>{const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){try{const value=await operation();if(accept(value))return value;}catch{}await delay(100);}throw new Error('Expected state not reached');}
test('real HAProxy applies routing, failover, size, method, path, rate and agent-loss boundaries',{timeout:30000},async t=>{
  const healthy=[false,false,false],calls=[0,0,0],healthChecks=[0,0,0];let failure=false;let failedRequests=0;let mode='normal';
  const fixtures=await Promise.all([0,1,2].map(async index=>fixture(async(req,res)=>{
    calls[index]++;
    if(failure&&index===0){failedRequests++;req.socket.destroy();return;}
    if(mode==='chunked'){res.writeHead(200,{'content-type':'application/json'});res.write('{');res.end('}');return;}
    const body=JSON.stringify(mode==='large'?{code:0,data:'x'.repeat(262145)}:head);
    if(mode==='normal')await delay(15);
    res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(body)});res.end(body);
  })));
  for(const f of fixtures)t.after(f.close);
  const healthServers:Server[]=[];
  for(const index of [0,1,2]){const s=createServer((_q,r)=>{if(healthy[index])healthChecks[index]++;r.writeHead(healthy[index]?200:503);r.end();});await new Promise<void>(resolve=>s.listen(9101+index,'127.0.0.1',resolve));healthServers.push(s);t.after(async()=>{if(s.listening)await close(s);});}
  const status=createServer((_q,r)=>r.end('{"gatewayAlive":true}'));await new Promise<void>(resolve=>status.listen(9090,'127.0.0.1',resolve));t.after(()=>close(status));
  const config=parseConfig({contractId:'fixture',controllers:['c1','c2','c3','c4','c5'],backends:fixtures.map((f,i)=>({id:'w'+(i+1),url:f.url})),reference:fixtures[0].url,policy});
  await mkdir('/run/poc',{recursive:true});await writeFile('/run/poc/fixture.cfg',haproxyConfig(config));
  const valid=spawnSync('/usr/sbin/haproxy',['-c','-f','/run/poc/fixture.cfg'],{encoding:'utf8'});
  assert.equal(valid.status,0,valid.stderr);
  const proxy=spawn('/usr/sbin/haproxy',['-db','-f','/run/poc/fixture.cfg'],{stdio:'ignore'});t.after(()=>stop(proxy));
  const get=(path='/chain/head',method='GET')=>fetch('http://127.0.0.1:8080'+path,{method,signal:AbortSignal.timeout(7000)});
  await eventually(()=>get('/status').then(r=>r.status),s=>s===200);
  assert.equal((await get()).status,503);
  healthy.fill(true);await eventually(()=>get().then(r=>r.status),s=>s===200);
  await eventually(async()=>healthChecks.every(n=>n>0),ready=>ready);await delay(50);
  const distribution=await Promise.all(Array.from({length:12},async()=>{const r=await get();assert.equal(r.status,200);await r.arrayBuffer();return r.headers.get('x-poc-backend');}));
  assert.deepEqual(new Set(distribution),new Set(['w1','w2','w3']));
  assert.equal((await get('/chain/append','POST')).status,405);
  for(const p of ['/tools/wallet/new','/settings/mempool/minfee/0','/chain/head/','/chain/block/01/hash'])assert.equal((await get(p)).status,403,p);
  assert.equal((await get('/chain/head?x=1')).status,400);
  assert.equal((await get('/chain/block/4294967296/hash')).status,400);
  assert.equal((await get('/chain/block/4294967295/hash')).status,200);
  mode='large';assert.equal((await get()).status,502);
  mode='chunked';assert.equal((await get()).status,502);mode='normal';
  failure=true;const before=calls.reduce((a,b)=>a+b,0);
  for(let i=0;i<12;i++){const r=await get();assert.equal(r.status,200);await r.arrayBuffer();}
  assert(failedRequests>0,'No request reached the deliberately failed backend');assert(calls.reduce((a,b)=>a+b,0)-before<=24,'More than one retry per request');
  healthy.fill(false);await eventually(()=>get().then(r=>r.status),s=>s===503);
  failure=false;healthy[0]=true;await eventually(()=>get().then(r=>r.status),s=>s===200);
  await close(healthServers[0]);await eventually(()=>get().then(r=>r.status),s=>s===503);
  healthy[1]=true;healthy[2]=true;mode='fast';await eventually(()=>get().then(r=>r.status),s=>s===200);
  let limited=0;for(let i=0;i<630;i++){const r=await get();if(r.status===429)limited++;await r.arrayBuffer();}assert(limited>0,'Rate limiting never activated');
});
test('actual gateway process keeps admission closed without connected controllers',{timeout:30000},async t=>{
  const worker=await fixture((req,res)=>{const data=req.url==='/peers/connected/connection'?{connections:[{},{}]}:req.url?.endsWith('/hash')?{hash}:head.data;res.end(JSON.stringify({code:0,data}));});t.after(worker.close);
  const config={contractId:'fixture',controllers:['c1','c2','c3','c4','c5'],backends:[{id:'w1',url:worker.url}],reference:worker.url,policy};
  await writeFile('/run/poc/runtime-test.json',JSON.stringify(config));
  let logs='';const child=spawn(process.execPath,['gateway/main.ts'],{env:{...process.env,PILOT_CONFIG:'/run/poc/runtime-test.json'},stdio:['ignore','pipe','pipe']});child.stdout?.on('data',data=>{logs=(logs+data).slice(-16000);});child.stderr?.on('data',data=>{logs=(logs+data).slice(-16000);});t.after(()=>stop(child));
  const getStatus=()=>fetch('http://127.0.0.1:8080/status').then(r=>r.json()) as Promise<{controllerQuorum:boolean;workers:{reason:string;eligible:boolean}[]}>;
  const status=await eventually(getStatus,s=>s.workers[0]?.reason==='healthy',5000);
  assert.equal(status.controllerQuorum,false);await delay(20500);
  const warmed=await getStatus();assert.equal(warmed.workers[0].reason,'healthy');assert.equal(warmed.workers[0].eligible,false);
  assert.equal((await fetch('http://127.0.0.1:8080/chain/head')).status,503,logs);
});
test('published compatibility defaults start with no workers and closed admission',{timeout:5000},async t=>{
  const env={...process.env};delete env.PILOT_CONFIG;
  const child=spawn(process.execPath,['gateway/bootstrap.ts'],{env,stdio:'ignore'});t.after(()=>stop(child));
  const status=await eventually(()=>fetch('http://127.0.0.1:8080/status').then(r=>r.json()) as Promise<{workers:unknown[];workerReady:boolean;controllerQuorum:boolean}>,value=>Array.isArray(value.workers));
  assert.equal(status.workers.length,0);assert.equal(status.workerReady,false);assert.equal(status.controllerQuorum,false);
  assert.equal((await fetch('http://127.0.0.1:8080/chain/head')).status,503);
  await stop(child);assert.equal(child.exitCode,0);
});

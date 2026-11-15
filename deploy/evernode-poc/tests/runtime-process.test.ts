import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {signControl} from '../fault/protocol.ts';
import {signSetup} from '../fault/setup.ts';
import type {ControlRequest} from '../fault/protocol.ts';
import type {SetupRequest} from '../fault/setup.ts';

type Status={generation:string;paused:boolean;observations:{applicationRunning:boolean;reporterRunning:boolean;role:string;resources:{memoryLimitBytes:number|null;volumeId:string|null;starts:number|null;quotaBytesVerified:boolean}}};
const fixture=JSON.parse(await readFile('tests/runtime-secrets.json','utf8')) as {contractId:string;operator:string;reporters:Record<string,string>};
const ca=await readFile('/contract/cfg/tlscert.pem');
const configuration={contractId:fixture.contractId,controllers:['c1','c2','c3','c4','c5'],controllerEndpoints:[1,2,3,4,5].map(i=>({id:'c'+i,url:'wss://127.0.0.1:'+(9800+i)+'/',serverKey:'ed'+String(i).repeat(64)})),backends:[1,2,3].map(i=>({id:'w'+i,url:'http://127.0.0.1:'+(3000+i)})),reference:'https://reference.example',policy:{checkpoint:{height:5000000,hash:'a'.repeat(64)},minimumHeight:5000000,maxLag:3,minPeers:2,maxLatencyMs:3000,freshnessMs:30000}};

async function request(port:number,path:string,body?:unknown,signature?:string,timeout=2000,secure=true):Promise<{status:number;body:unknown}>{
  return new Promise((resolve,reject)=>{
    const encoded=body?JSON.stringify(body):undefined;
    const req=(secure?httpsRequest:httpRequest)({hostname:'127.0.0.1',port,path,method:encoded?'POST':'GET',...(secure?{ca,rejectUnauthorized:true}:{}),agent:false,headers:{...(encoded?{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}:{}),...(signature?{'x-pilot-signature':signature}:{})}},response=>{
      const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{try{const text=Buffer.concat(chunks).toString('utf8');resolve({status:response.statusCode!,body:text.startsWith('{')?JSON.parse(text):text});}catch(error){reject(error);}});
    });req.setTimeout(timeout,()=>req.destroy(new Error('Fixture request deadline')));req.on('error',reject);req.end(encoded);
  });
}
async function until<T>(probe:()=>Promise<T>,accept:(value:T)=>boolean,timeout=15000):Promise<T>{
  const end=Date.now()+timeout;while(Date.now()<end){try{const value=await probe();if(accept(value))return value;}catch{}await delay(50);}throw new Error('Runtime fixture condition timed out');
}
function launch(mode:'worker'|'gateway'):{child:ChildProcess;logs:()=>string}{
  const child=spawn(process.execPath,['runtime/main.ts'],{env:{...process.env,PILOT_RUNTIME:mode,ROLE:mode==='worker'?'w1':'g1',INTERNAL_PEER_PORT:'9186',EXTERNAL_PEER_PORT:'30212',INTERNAL_USER_PORT:mode==='worker'?'3001':'9445',EXTERNAL_USER_PORT:mode==='worker'?'30222':'30322',INTERNAL_GPTCP1_PORT:'9444'},stdio:['ignore','pipe','pipe']});
  let logs='';for(const stream of [child.stdout,child.stderr])stream?.on('data',chunk=>{logs+=chunk.toString();if(logs.length>65536)logs=logs.slice(-65536);});
  return{child,logs:()=>logs};
}
async function stop(child:ChildProcess){
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exited=once(child,'exit');
  // The production supervisor drops to UID 1000. Signal it as that same user;
  // the fixture deliberately has no CAP_KILL.
  const result=spawnSync('/bin/kill',['-TERM',String(child.pid)],{uid:1000,gid:1000,stdio:'ignore'});
  if(result.status!==0)child.kill('SIGTERM');
  const outcome=await Promise.race([exited.then(()=>true),delay(12000,false,{ref:false})]);assert.equal(outcome,true,'Supervisor did not shut down cleanly');
}
async function install(role:string,port:number,status:Status){
  const setup:SetupRequest={version:1,contractId:fixture.contractId,targetId:role,generation:status.generation,operationId:randomUUID(),issuedAt:Date.now(),reporterKey:fixture.reporters[role],config:configuration};
  const installed=await request(port,'/pilot/setup',setup,signSetup(setup,fixture.operator));assert.equal(installed.status,200);assert.equal(JSON.stringify(installed.body).includes(fixture.reporters[role]),false);
}
async function pause(role:string,port:number,status:Status){
  const command:ControlRequest={version:1,contractId:fixture.contractId,targetId:role,generation:status.generation,operationId:randomUUID(),action:'pause',issuedAt:Date.now(),durationMs:600};
  assert.equal((await request(port,'/pilot/control',command,signControl(command,fixture.operator))).status,200);
}

test('worker runtime uses mapped ports, persists data across restart and starts its protected reporter',{timeout:45000},async t=>{
  let current=launch('worker');t.after(async()=>{await stop(current.child);});
  try{
    const status=await until(async()=>((await request(9444,'/pilot/status')).body as Status),value=>value.observations.applicationRunning);
    assert.equal(status.observations.role,'w1');assert.ok(status.observations.resources.memoryLimitBytes);
    await until(()=>request(3001,'/chain/head',undefined,undefined,1000,false),value=>value.status===200);
    const tlsHead=await request(9444,'/chain/head');assert.equal(tlsHead.status,200);assert.equal((tlsHead.body as {code:number}).code,0);
    assert.equal((await request(9444,'/settings')).status,404);
    await install('w1',9444,status);
    await until(async()=>((await request(9444,'/pilot/status')).body as Status),value=>value.observations.reporterRunning);
    assert.match(current.logs(),/P2P endpoint is 0\.0\.0\.0:9186\./);assert.match(current.logs(),/P2P advertised port is 30212\./);assert.match(current.logs(),/RPC endpoint is 127\.0\.0\.1:3000\./);
    const marker=(await readFile('/warthog/.warthog/.evernode-volume-id','utf8')).trim();
    const beforeStatus=(await request(9444,'/pilot/status')).body as Status;assert.equal(beforeStatus.observations.resources.volumeId,marker);assert.equal(beforeStatus.observations.resources.starts,1);assert.equal(beforeStatus.observations.resources.quotaBytesVerified,false);
    await pause('w1',9444,status);await assert.rejects(request(3001,'/chain/head',undefined,undefined,150,false));
    await until(()=>request(3001,'/chain/head',undefined,undefined,1000,false),value=>value.status===200);
    await stop(current.child);current=launch('worker');
    await until(async()=>((await request(9444,'/pilot/status')).body as Status),value=>value.observations.applicationRunning&&value.observations.reporterRunning);
    await until(()=>request(3001,'/chain/head',undefined,undefined,1000,false),value=>value.status===200);
    assert.equal((await readFile('/warthog/.warthog/.evernode-volume-id','utf8')).trim(),marker);assert.match(current.logs(),/restored=1 starts=2/);assert.match(current.logs(),/mode=network/);
    const afterStatus=(await request(9444,'/pilot/status')).body as Status;assert.equal(afterStatus.observations.resources.volumeId,marker);assert.equal(afterStatus.observations.resources.starts,2);
  }catch(error){console.error(current.logs().split('\n').filter(line=>!/private.?key|secret|password|ed[0-9a-f]{128}/i.test(line)).join('\n'));throw error;}
});
test('gateway runtime reloads only verified setup and pauses its whole proxy process group',{timeout:45000},async t=>{
  const current=launch('gateway');t.after(async()=>{await stop(current.child);});
  try{
    const status=await until(async()=>((await request(9445,'/pilot/status')).body as Status),value=>value.observations.applicationRunning);
    await until(()=>request(8443,'/status'),value=>value.status===200);
    assert.equal((await request(8443,'/pilot/control')).status,403);
    await install('g1',9445,status);
    await until(async()=>((await request(9445,'/pilot/status')).body as Status),value=>value.observations.applicationRunning&&value.observations.reporterRunning);
    await until(()=>request(8443,'/chain/head'),value=>value.status===503);
    assert.equal((await request(8443,'/settings')).status,403);
    await pause('g1',9445,status);await assert.rejects(request(8443,'/status',undefined,undefined,150));
    await until(()=>request(8443,'/status'),value=>value.status===200);
  }catch(error){console.error(current.logs().split('\n').filter(line=>!/private.?key|secret|password|ed[0-9a-f]{128}/i.test(line)).join('\n'));throw error;}
});

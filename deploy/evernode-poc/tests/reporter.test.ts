import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {makeReport} from '../reporter/report.ts';
import {reserveSequence} from '../reporter/sequence.ts';
import {sendReport} from '../reporter/transport.ts';
import {reporterKeys} from '../reporter/identity.ts';
import {loadHotPocket} from '../shared/hotpocket.ts';
import type {HpFactory} from '../reporter/transport.ts';
import type {HpKeys,HpClient} from '../shared/hotpocket.ts';
import type {PoolSample} from '../shared/pool-probe.ts';
import {initialState,reduceRound} from '../controller/reducer.ts';
import policy from '../shared/mainnet-policy.json' with {type:'json'};
const backends=['w1','w2','w3'].map(id=>({id,url:'http://'+id+'.example'}));
const hash='a'.repeat(64);
test('the actual SDK reloads a disposable identity; a mismatched seed cannot borrow its public half',async()=>{
  const hp=loadHotPocket(),generated=await hp.generateKeys(),publicKey=Buffer.from(generated.publicKey).toString('hex');
  const reloaded=await reporterKeys(Buffer.from(generated.privateKey).toString('hex'),publicKey);
  assert.equal(Buffer.from(reloaded.publicKey).toString('hex'),publicKey);
  const wrong=Buffer.from(generated.privateKey);wrong[1]^=1;
  await assert.rejects(reporterKeys(wrong.toString('hex'),publicKey),/does not match/);
});
function samples(now:number):Map<string,PoolSample>{return new Map(backends.map(b=>[b.id,{observation:{observedAt:now,head:{height:5000100,hash,synced:true},peers:8,checkpointHash:policy.checkpoint.hash,latencyMs:20,common:{height:5000000,hash}},assessment:{healthy:true,reason:'healthy'}}]));}
test('reports keep warming evidence and mark missing or stale workers unreachable',()=>{
  const observations=samples(1000);observations.get('w1')!.observation!.head.synced=false;observations.get('w1')!.observation!.checkpointHash=null;
  observations.get('w2')!.observation!.observedAt=-40000;observations.delete('w3');
  const report=makeReport(42,1100,backends,observations);
  assert.equal(report.observedAt,1000);assert.equal(report.workers[0].reachable,true);assert.equal(report.workers[0].checkpointHash,null);assert.equal(report.workers[0].head?.synced,false);assert.deepEqual(report.workers.slice(1),[{id:'w2',reachable:false},{id:'w3',reachable:false}]);
});
test('three authenticated reporter payloads drive controller admission and later removal',()=>{
  const config={contractId:'pilot',workers:backends.map(b=>b.id),reporters:['r1','r2','r3','r4','r5'],policy};let state=initialState(config);
  for(let round=0;round<5;round++){
    const now=100000+round*1000,observations=samples(now);
    for(const sample of observations.values())sample.observation!.common!.height=state.probeHistory.at(-1)?.height??policy.checkpoint.height;
    observations.get('w3')!.observation!.common!.hash='b'.repeat(64);
    state=reduceRound(state,config,now,config.reporters.slice(0,3).map(publicKey=>({publicKey,body:makeReport(round,now,backends,observations)})));
  }
  assert.deepEqual(state.snapshots.at(-1)!.eligible,['w1','w2']);
  for(let round=5;round<8;round++){
    const now=100000+round*1000,observations=samples(now);observations.delete('w1');
    for(const sample of observations.values())sample.observation!.common!.height=state.probeHistory.at(-1)?.height??policy.checkpoint.height;
    state=reduceRound(state,config,now,config.reporters.slice(0,3).map(publicKey=>({publicKey,body:makeReport(round,now,backends,observations)})));
  }
  assert(!state.snapshots.at(-1)!.eligible.includes('w1'));
});
test('sequence survives restart and clock rollback; corrupted or locked state is never reset',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'reporter-sequence-')),path=join(dir,'sequence.json');
  try{
    assert.equal(await reserveSequence(path,1000),1000);assert.equal(await reserveSequence(path,900),1001);assert.equal(await reserveSequence(path,1200),1200);
    await writeFile(path+'.lock','another process');await assert.rejects(reserveSequence(path,1300));assert.equal(JSON.parse(await readFile(path,'utf8')).last,1200);await rm(path+'.lock');
    await writeFile(path,'invalid json');await assert.rejects(reserveSequence(path,1400));assert.equal(await readFile(path,'utf8'),'invalid json');
  }finally{await rm(dir,{recursive:true,force:true});}
});
const endpoint={id:'c1',url:'wss://controller.example/',serverKey:'ed'+'a'.repeat(64)};
const keys:HpKeys={publicKey:new Uint8Array(33),privateKey:new Uint8Array(65)};
function fakeHp(behavior:'accept'|'reconnect'|'foreign'|'hang'|'hang-close',capture:Record<string,unknown>):HpFactory{
  let listener:(...args:unknown[])=>void=()=>{};
  const client:HpClient={
    on:(_event,callback)=>{listener=callback;},
    connect:async()=>{listener(endpoint.url,'add');return true;},
    close:async()=>{capture.closed=true;if(behavior==='hang-close')await new Promise(()=>{});},
    submitContractReadRequest:async()=>null,
    submitContractInput:async(body,nonce,maxLedger,isOffset)=>{capture.input={body,nonce,maxLedger,isOffset};if(behavior==='reconnect')listener(endpoint.url,'remove');if(behavior==='foreign')listener('wss://other.example/','add');return{hash:new Uint8Array(32),submissionStatus:behavior==='hang'||behavior==='hang-close'?new Promise(()=>{}):Promise.resolve({status:'accepted'})};}
  };
  return{events:{connectionChange:'connection_change'},setLogLevel:()=>{},generateKeys:async()=>keys,createClient:async(urls,_keys,options)=>{capture.urls=urls;capture.options=options;return client;}};
}
test('report transport pins one identity and bounds the input ledger lifetime',async()=>{
  const capture:Record<string,unknown>={};assert.equal(await sendReport(fakeHp('accept',capture),keys,'pilot',endpoint,'{}',100),true);
  assert.deepEqual(capture.urls,[endpoint.url]);assert.equal((capture.options as Record<string,unknown>).contractId,'pilot');assert.deepEqual((capture.options as Record<string,unknown>).trustedServerKeys,[endpoint.serverKey]);assert.deepEqual(capture.input,{body:'{}',nonce:100,maxLedger:10,isOffset:true});assert.equal(capture.closed,true);
});
for(const behavior of ['reconnect','foreign'] as const)test('an accepted input after '+behavior+' cannot count as a pinned acknowledgment',async()=>{const capture:Record<string,unknown>={};assert.equal(await sendReport(fakeHp(behavior,capture),keys,'pilot',endpoint,'{}',100),false);assert.equal(capture.closed,true);});
test('missing acknowledgment and stuck socket cleanup remain bounded',async()=>{
  for(const behavior of ['hang','hang-close'] as const){const capture:Record<string,unknown>={},began=performance.now();assert.equal(await sendReport(fakeHp(behavior,capture),keys,'pilot',endpoint,'{}',100,20),false);assert(performance.now()-began<500);assert.equal(capture.closed,true);}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,reduceRound} from '../controller/reducer.ts';
import type {ControllerConfig,PoolState,AuthenticatedInput} from '../controller/reducer.ts';
import {stateHash} from '../controller/registry.ts';
import {hash} from './helpers.ts';
const config:ControllerConfig={contractId:'pilot',workers:['w1','w2','w3'],reporters:['r1','r2','r3','r4','r5'],policy:{checkpoint:{height:5000000,hash},minimumHeight:5000000,maxLag:3,minPeers:2,maxLatencyMs:3000,freshnessMs:30000}};
const start=100000;
function reports(sequence:number,now:number,options:{lag?:boolean;conflict?:boolean;zero?:boolean;reporters?:string[]}={}):AuthenticatedInput[]{return(options.reporters||config.reporters).map(publicKey=>({publicKey,body:{type:'health-report',sequence,observedAt:now,workers:config.workers.map(id=>({id,reachable:true,head:{height:options.zero?0:options.lag&&id==='w3'?5000000:5000100,hash,synced:true},peers:4,checkpointHash:hash,latencyMs:100,common:{height:5000090,hash:options.conflict&&id==='w3'?'b'.repeat(64):hash}}))}}));}
function warmed():PoolState{let state=initialState(config);for(let n=1;n<=4;n++)state=reduceRound(state,config,start+n*10000,reports(n,start+n*10000));return state;}
test('three distinct report windows after common-checkpoint bootstrap admit',()=>{const state=warmed();assert.deepEqual(state.snapshots.at(-1)?.eligible,['w1','w2','w3']);assert.equal(state.probeHistory.at(-1)?.height,5000090);});
test('consensed input order cannot change state or registry hash',()=>{const initial=initialState(config),inputs=reports(1,start);const a=reduceRound(initial,config,start,inputs),b=reduceRound(initial,config,start,[...inputs].reverse());assert.deepEqual(a,b);assert.equal(stateHash(a.snapshots.at(-1)!),stateHash(b.snapshots.at(-1)!));});
test('one reporter cannot advance hysteresis by replaying reports or sending many sequences',()=>{
  let state=initialState(config);state=reduceRound(state,config,start,reports(1,start));const before=state.decisions.w1.successes;
  state=reduceRound(state,config,start+2000,reports(1,start));assert.equal(state.decisions.w1.successes,before);
  const spam=[2,3,4,5].flatMap(n=>reports(n,start+4000,{reporters:['r1']}));state=reduceRound(state,config,start+4000,spam);assert.equal(state.decisions.w1.successes,before);
});
test('height zero with synced true never admits',()=>{let state=initialState(config);for(let n=1;n<=5;n++)state=reduceRound(state,config,start+n*10000,reports(n,start+n*10000,{zero:true}));assert.deepEqual(state.snapshots.at(-1)?.eligible,[]);});
for(const option of ['lag','conflict'] as const)test(option+' excludes only the disagreeing worker after three checks',()=>{let state=warmed();for(let n=5;n<=7;n++)state=reduceRound(state,config,start+n*10000,reports(n,start+n*10000,{[option]:true}));assert.deepEqual(state.snapshots.at(-1)?.eligible,['w1','w2']);});
test('two approved reporters plus unknown identities cannot form quorum',()=>{const state=reduceRound(initialState(config),config,start,reports(1,start,{reporters:['r1','r2','attacker1','attacker2','attacker3']}));assert.equal(Object.keys(state.reports).length,2);assert.deepEqual(state.snapshots.at(-1)?.eligible,[]);});
test('expired telemetry revokes eligibility without fabricating new report samples',()=>{const state=warmed();const next=reduceRound(state,config,state.committedAt+30001,[]);assert.deepEqual(next.snapshots.at(-1)?.eligible,[]);assert.equal(next.decisions.w1.reason,'missing-report-quorum');});
test('paused global block production remains healthy with fresh agreed reports',()=>{let state=warmed();for(let n=5;n<=10;n++)state=reduceRound(state,config,start+n*10000,reports(n,start+n*10000));assert.deepEqual(state.snapshots.at(-1)?.eligible,['w1','w2','w3']);});
test('conflicting same-sequence inputs from one identity cannot vote twice',()=>{const a=reports(1,start,{reporters:['r1','r2','r3']}),b=reports(1,start,{reporters:['r1'],conflict:true});const state=reduceRound(initialState(config),config,start,[...a,...b]);assert.equal(Object.keys(state.reports).length,2);});
test('keeps ten committed snapshots and bounded reporter state',()=>{let state=warmed();for(let n=5;n<30;n++)state=reduceRound(state,config,start+n*10000,reports(n,start+n*10000));assert.equal(state.snapshots.length,10);assert.equal(Object.keys(state.reports).length,5);assert(state.probeHistory.length<=4);});
test('one warming worker with no checkpoint does not discard the healthy workers reports',()=>{let state=initialState(config);for(let n=1;n<=4;n++){const inputs=reports(n,start+n*10000).map(input=>{const body=input.body as {workers:Record<string,unknown>[]};const worker=body.workers.find(w=>w.id==='w3')!;worker.head={height:1000,hash,synced:false};worker.checkpointHash=null;delete worker.common;return input;});state=reduceRound(state,config,start+n*10000,inputs);}assert.deepEqual(state.snapshots.at(-1)?.eligible,['w1','w2']);});

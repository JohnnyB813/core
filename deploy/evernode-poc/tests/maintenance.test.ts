import test from 'node:test';
import assert from 'node:assert/strict';
import {reduceMaintenance,parseMaintenance} from '../controller/maintenance.ts';
import {initialState,reduceRound} from '../controller/reducer.ts';
import type {ControllerConfig} from '../controller/reducer.ts';
const policy={checkpoint:{height:5000000,hash:'a'.repeat(64)},minimumHeight:5000000,maxLag:3,minPeers:2,maxLatencyMs:3000,freshnessMs:30000};
const config:ControllerConfig={contractId:'pilot',workers:['w1','w2','w3'],reporters:['r1','r2','r3','r4','r5'],operationOwner:'owner',policy};
const control=(revision:number,excludedWorkers:string[],publicKey='owner')=>({publicKey,body:{type:'worker-maintenance',revision,excludedWorkers,issuedAt:100}});
test('only fresh owner controls can exclude at most one replacement worker',()=>{
  const empty={revision:0,excludedWorkers:[]};assert.deepEqual(reduceMaintenance(empty,'owner',100,[control(1,['w1'],'reporter')]),empty);
  assert.deepEqual(reduceMaintenance(empty,'owner',30101,[control(1,['w1'])]),empty);
  assert.throws(()=>parseMaintenance({revision:1,excludedWorkers:['w1','w2']}));
  assert.deepEqual(reduceMaintenance(empty,'owner',100,[control(1,['w1'])]),{revision:1,excludedWorkers:['w1']});
});
test('maintenance revisions survive replay and same-revision conflicts change nothing',()=>{
  const prior={revision:5,excludedWorkers:['w1']};assert.deepEqual(reduceMaintenance(prior,'owner',100,[control(5,[])]),prior);
  const inputs=[control(6,[]),control(6,['w2'])];assert.deepEqual(reduceMaintenance(prior,'owner',100,inputs),prior);assert.deepEqual(reduceMaintenance(prior,'owner',100,[...inputs].reverse()),prior);
});
test('maintenance overrides eligibility and release cannot reuse old report samples',()=>{
  const state=initialState(config);state.decisions.w1.eligible=true;state.decisions.w1.successes=5;state.lastSequences={r1:99,r2:100,r3:101};
  const excluded=reduceRound(state,config,100,[control(1,['w1'])]);assert.equal(excluded.decisions.w1.eligible,false);assert.equal(excluded.decisions.w1.reason,'operator-maintenance');assert.deepEqual(excluded.operations?.snapshots[0].maintenance,{revision:1,excludedWorkers:['w1']});
  const released=reduceRound(excluded,config,101,[control(2,[])]);assert.equal(released.decisions.w1.eligible,false);assert.equal(released.decisions.w1.successes,0);assert.deepEqual(released.decisions.w1.lastCounted,state.lastSequences);
});

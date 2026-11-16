import test from 'node:test';
import assert from 'node:assert/strict';
import {assess,Hysteresis,parseHead,parsePeers} from '../shared/health.ts';
import type {Policy,Observation} from '../shared/health.ts';
import {hash,head} from './helpers.ts';
const policy:Policy={checkpoint:{height:5000000,hash},minimumHeight:5000000,maxLag:3,minPeers:2,maxLatencyMs:3000,freshnessMs:30000};
const observation:Observation={observedAt:100000,head:parseHead(head),peers:4,checkpointHash:hash,latencyMs:100};
test('healthy caught-up checkpoint passes',()=>assert.deepEqual(assess(observation,5000100,100100,policy),{healthy:true,reason:'healthy'}));
for (const [name,changes,reason] of [
  ['height zero despite synced true',{head:{height:0,hash,synced:true}},'below-bootstrap-floor'],
  ['below floor',{head:{height:4999999,hash,synced:true}},'below-bootstrap-floor'],
  ['sync incomplete',{head:{...observation.head,synced:false}},'sync-incomplete'],
  ['wrong checkpoint',{checkpointHash:'b'.repeat(64)},'checkpoint-mismatch'],
  ['lagging tip',{head:{...observation.head,height:5000090}},'tip-disagreement'],
  ['unsupported far-ahead tip',{head:{...observation.head,height:5000110}},'tip-disagreement'],
  ['too few peers',{peers:1},'insufficient-peers'],
  ['slow API',{latencyMs:3001},'slow-response'],
  ['stale telemetry',{observedAt:60000},'stale-observation'],
  ['future telemetry',{observedAt:100101},'stale-observation']
] as [string,Partial<Observation>,string][])test(name,()=>assert.equal(assess({...observation,...changes},5000100,100100,policy).reason,reason));
test('block production pause does not fail healthy peers',()=>assert.equal(assess({...observation,observedAt:900000},5000100,900100,policy).healthy,true));
test('reject malformed or different API schema',()=>{
  for(const value of [{code:1,data:head.data},{code:0,data:{...head.data,height:'5000100'}},{code:0,data:{...head.data,synced:'true'}},{code:0,data:{...head.data,height:NaN}},{code:0,data:{chainHead:head.data,synced:true}}])assert.throws(()=>parseHead(value));
});
test('require one bounded connection list',()=>{assert.equal(parsePeers({code:0,data:{connections:[{},{}]}}),2);assert.throws(()=>parsePeers({code:0,data:{}}));assert.throws(()=>parsePeers({code:0,data:{a:[],b:[]}}));});
test('three separate successful checks admit, three failures evict',()=>{
  const state=new Hysteresis();
  assert.equal(state.update(1,true),false);assert.equal(state.update(2,true),false);assert.equal(state.update(3,true),true);
  assert.equal(state.update(4,false),true);assert.equal(state.update(5,false),true);assert.equal(state.update(6,false),false);
  assert.equal(state.update(7,true),false);assert.throws(()=>state.update(7,true));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {OperationPoller,pairedOperationReplies} from '../deploy/operation-poller.ts';
import {operationHash} from '../controller/operations.ts';
import {stateHash} from '../controller/registry.ts';
import type {OperationSnapshot} from '../controller/operations.ts';
import type {Snapshot} from '../controller/registry.ts';
import type {HpClient} from '../shared/hotpocket.ts';
const contractId='11111111-2222-4333-8444-555555555555',now=100000;
const pins=Array.from({length:5},(_,i)=>({id:'c'+(i+1),url:'wss://c'+(i+1)+'.example:32001/',serverKey:'ed'+String(i+1).repeat(64)}));
const health:Snapshot={contractId,sequence:10,committedAt:now-1,eligible:[],probeHeight:5000000};
const operation:OperationSnapshot={contractId,sequence:10,committedAt:now-1,healthStateHash:stateHash(health),intent:null,claim:null,result:null,maintenance:{revision:0,excludedWorkers:[]}};
function wire(){return{health:JSON.stringify({type:'registry-history',snapshots:[{snapshot:health,stateHash:stateHash(health)}]}),operations:JSON.stringify({type:'operation-history',snapshots:[{snapshot:operation,stateHash:operationHash(operation)}]})};}
test('paired histories require the same committed sequence and bound health hash',()=>{
 const w=wire();assert.equal(pairedOperationReplies('c1',contractId,now,w.health,w.operations).length,1);
 const changed={...health,sequence:11};const mismatched=JSON.stringify({type:'registry-history',snapshots:[{snapshot:changed,stateHash:stateHash(changed)}]});
 assert.equal(pairedOperationReplies('c1',contractId,now,mismatched,w.operations).length,0);
 assert.throws(()=>pairedOperationReplies('c1',contractId,now,w.health,' '.repeat(65537)));
});
test('one fresh client per pin supplies four paired histories; reconnecting or foreign servers have no vote',async()=>{
 for(const bad of ['c5','c4,c5']){
  let created=0,closed=0,inputs=0;
  const poller=new OperationPoller(contractId,pins,{publicKey:Buffer.alloc(33),privateKey:Buffer.alloc(65)},async endpoint=>{
   created++;const events=new Map<string,((...args:unknown[])=>void)[]>();
   const client:HpClient={on:(event,fn)=>{events.set(event,[...(events.get(event)||[]),fn]);},connect:async()=>{events.get('connection_change')?.forEach(fn=>fn(bad.includes(endpoint.id)?'wss://foreign.example/':endpoint.url,'add'));return true;},close:async()=>{closed++;},submitContractInput:async()=>{inputs++;throw new Error('No writes expected');},submitContractReadRequest:async raw=>JSON.parse(String(raw)).type==='registry-history'?wire().health:wire().operations};return client;
  },()=>now);
  const result=await poller.poll();assert.equal(result?.controllers.length??0,bad==='c5'?4:0);assert.equal(created,5);assert.equal(inputs,0);await poller.close();assert(closed>=5);
 }
});

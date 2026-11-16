import test from 'node:test';
import assert from 'node:assert/strict';
import {initialOperations,reduceOperations,operationHash,parseOperationSnapshot} from '../controller/operations.ts';
import type {OperationState} from '../controller/operations.ts';
import {stateHash} from '../controller/registry.ts';
const owner='owner',executor='executor',id='11111111-2222-4333-8444-555555555555',claimId='22222222-2222-4333-8444-555555555555',policyHash='a'.repeat(64),tx='b'.repeat(64);
const health=(now:number,eligible=['w3'])=>({contractId:'pilot',sequence:now,committedAt:now,eligible,probeHeight:5000000});
const input=(publicKey:string,body:unknown)=>({publicKey,body});
const authorize={type:'canary-authorize',operationId:id,policyHash,notBefore:100,expiresAt:10000};
const claim={type:'canary-claim',operationId:id,policyHash,claimId};
const reduce=(state:OperationState,now:number,inputs:ReturnType<typeof input>[],eligible=['w3'])=>reduceOperations(state,'pilot',owner,executor,now,inputs,health(now,eligible));
test('only the configured owner can authorize one immutable canary policy',()=>{
  assert.equal(reduce(initialOperations(),100,[input('reporter',authorize)]).intent,null);
  const accepted=reduce(initialOperations(),100,[input(owner,authorize)]);assert.equal(accepted.intent?.policyHash,policyHash);
  const replaced=reduce(accepted,101,[input(owner,{...authorize,operationId:claimId,policyHash:'c'.repeat(64),notBefore:101})]);assert.deepEqual(replaced.intent,accepted.intent);
  const conflict=[input(owner,authorize),input(owner,{...authorize,policyHash:'c'.repeat(64)})];assert.equal(reduce(initialOperations(),100,conflict).intent,null);assert.equal(reduce(initialOperations(),100,[...conflict].reverse()).intent,null);
});
test('claiming requires the authorized executor, policy window and admitted canary worker',()=>{
  const state=reduce(initialOperations(),100,[input(owner,authorize)]);
  assert.equal(reduce(state,101,[input(owner,claim)]).claim,null);
  assert.equal(reduce(state,101,[input(executor,claim)],[]).claim,null);
  assert.equal(reduce(state,10000,[input(executor,claim)]).claim,null);
  const claimed=reduce(state,101,[input(executor,claim)]);assert.equal(claimed.claim?.claimId,claimId);
  assert.deepEqual(reduce(claimed,102,[input(executor,{...claim,claimId:id})]).claim,claimed.claim);
});
test('simultaneous claim candidates resolve independently of arrival order',()=>{
  const state=reduce(initialOperations(),100,[input(owner,authorize)]),inputs=[input(executor,claim),input(executor,{...claim,claimId:id})];
  assert.deepEqual(reduce(state,101,inputs),reduce(state,101,[...inputs].reverse()));
});
test('transaction receipts cannot change the policy and conflicting transactions stay marked',()=>{
  const state=reduce(reduce(initialOperations(),100,[input(owner,authorize)]),101,[input(executor,claim)]),result={type:'canary-result',operationId:id,claimId,transactionHash:tx,stage:'validated'};
  assert.equal(reduce(state,102,[input(owner,result)]).result,null);
  const first=reduce(state,102,[input(executor,result)]);assert.equal(first.result?.transactionHash,tx);
  const confirmed=reduce(first,103,[input(executor,{...result,stage:'host-confirmed'})]);assert.equal(confirmed.result?.stage,'host-confirmed');
  const conflict=reduce(confirmed,104,[input(executor,{...result,transactionHash:'c'.repeat(64)})]);assert.equal(conflict.result?.conflict,true);assert.equal(reduce(conflict,105,[]).result?.conflict,true);
});
test('operation histories bind the unchanged health snapshot and canonically validate their fields',()=>{
  const state=reduce(initialOperations(),100,[input(owner,authorize)]),snapshot=state.snapshots[0];assert.equal(snapshot.healthStateHash,stateHash(health(100)));
  const reordered={...snapshot,intent:snapshot.intent?Object.fromEntries(Object.entries(snapshot.intent).reverse()):null};assert.equal(operationHash(reordered as typeof snapshot),operationHash(snapshot));
  assert.throws(()=>parseOperationSnapshot({...snapshot,secret:'bad'}));assert.throws(()=>parseOperationSnapshot({...snapshot,intent:{...snapshot.intent,authorizedAt:101}}));
  let current=state;for(let now=101;now<121;now++)current=reduce(current,now,[]);assert.equal(current.snapshots.length,10);
});

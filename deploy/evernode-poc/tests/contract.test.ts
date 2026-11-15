import test from 'node:test';
import assert from 'node:assert/strict';
import {executeContract} from '../controller/contract.ts';
import type {ContractContext,ContractUser,StateStore} from '../controller/contract.ts';
import type {ControllerConfig,PoolState} from '../controller/reducer.ts';
import {hash} from './helpers.ts';
const config:ControllerConfig={contractId:'pilot',workers:['w1','w2','w3'],reporters:['r1','r2','r3','r4','r5'],policy:{checkpoint:{height:5000000,hash},minimumHeight:5000000,maxLag:3,minPeers:2,maxLatencyMs:3000,freshnessMs:30000}};
function setup(readonly:boolean,senders:{key:string;bodies:unknown[]}[]){
  const data=new Map<number,Buffer>(),outputs:Record<string,string[]>={};let cursor=0;
  const users:ContractUser[]=senders.map(sender=>({publicKey:sender.key,inputs:sender.bodies.map(body=>{const buffer=Buffer.from(JSON.stringify(body));const offset=cursor++;data.set(offset,buffer);return[offset,buffer.length];}),send:async message=>{(outputs[sender.key]??=[]).push(message);}}));
  const ctx:ContractContext={contractId:'pilot',readonly,timestamp:100000,users:{list:()=>users,read:async input=>data.get(input[0])!}};
  let state:PoolState|null=null,writes=0;
  const store:StateStore={load:async()=>state,save:async value=>{state=value;writes++;}};
  return{ctx,store,outputs,getState:()=>state,getWrites:()=>writes};
}
test('readonly registry requests do not write or advance state',async()=>{const fixture=setup(true,[{key:'observer',bodies:[{type:'registry-history'}]}]);await executeContract(fixture.ctx,config,fixture.store);assert.equal(fixture.getWrites(),0);assert.deepEqual(JSON.parse(fixture.outputs.observer[0]).snapshots,[]);});
test('public-key identity comes from HotPocket context, not a claimed reporter field',async()=>{const body={type:'health-report',reporter:'r1',sequence:1,observedAt:100000,workers:config.workers.map(id=>({id,reachable:false}))};const fixture=setup(false,[{key:'unknown',bodies:[body]},{key:'r2',bodies:[body]}]);await executeContract(fixture.ctx,config,fixture.store);assert.deepEqual(Object.keys(fixture.getState()!.reports),['r2']);assert.equal(fixture.getWrites(),1);});
test('reporter input flood does not prevent other approved reports',async()=>{const body={type:'health-report',sequence:1,observedAt:100000,workers:config.workers.map(id=>({id,reachable:false}))};const fixture=setup(false,[{key:'r1',bodies:Array(21).fill(body)},{key:'r2',bodies:[body]},{key:'r3',bodies:[body]},{key:'r4',bodies:[body]}]);await executeContract(fixture.ctx,config,fixture.store);assert.deepEqual(Object.keys(fixture.getState()!.reports),['r2','r3','r4']);});
test('wrong contract identity and corrupt state fail rather than reset',async()=>{const fixture=setup(false,[]);fixture.ctx.contractId='other';await assert.rejects(executeContract(fixture.ctx,config,fixture.store));fixture.ctx.contractId='pilot';fixture.store.load=async()=>{throw new Error('Corrupt state');};await assert.rejects(executeContract(fixture.ctx,config,fixture.store),/Corrupt state/);assert.equal(fixture.getWrites(),0);});

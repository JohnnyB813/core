import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {FaultController} from '../fault/controller.ts';
import type {ControlState,ControlStore} from '../fault/controller.ts';
import {signControl} from '../fault/protocol.ts';
import type {ControlRequest} from '../fault/protocol.ts';
class Store implements ControlStore {state:ControlState|null=null;async load(){return structuredClone(this.state);}async save(state:ControlState){this.state=structuredClone(state);}}
async function fixture(){
  const keys=generateKeyPairSync('ed25519'),store=new Store(),signals:string[]=[];let now=100000;
  const config={contractId:'pilot',targetId:'w1',operatorPublicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64')};
  const target={pause:async()=>{signals.push('pause');},resume:async()=>{signals.push('resume');}};
  const controller=await FaultController.create(config,target,store,()=>now);
  const request=(changes:Partial<ControlRequest>={}):ControlRequest=>({version:1,contractId:'pilot',targetId:'w1',generation:controller.status().generation,operationId:randomUUID(),action:'pause',issuedAt:now,durationMs:60000,...changes});
  return{keys,store,signals,controller,config,target,request,advance:(ms:number)=>{now+=ms;},clock:()=>now};
}
test('only the configured operator can pause the named process',async()=>{
  const f=await fixture(),request=f.request(),other=generateKeyPairSync('ed25519');
  await assert.rejects(f.controller.execute(request,signControl(request,other.privateKey)),/unauthorized/);assert.deepEqual(f.signals,[]);
  const result=await f.controller.execute(request,signControl(request,f.keys.privateKey));assert.equal(result.receipt.state,'applied');assert.equal(result.status.paused,true);assert.deepEqual(f.signals,['pause']);
});
test('wrong role, stale generation, expired requests and shell-like extra fields are rejected',async()=>{
  const f=await fixture();
  for(const changes of [{targetId:'w2'},{generation:randomUUID()},{issuedAt:1},{issuedAt:110000}]){
    const request=f.request(changes);await assert.rejects(f.controller.execute(request,signControl(request,f.keys.privateKey)));
  }
  await assert.rejects(f.controller.execute({...f.request(),command:'arbitrary'},'x'));assert.deepEqual(f.signals,[]);
});
test('concurrent delivery of one operation signals once and cannot extend its deadline',async()=>{
  const f=await fixture(),request=f.request(),signature=signControl(request,f.keys.privateKey);
  const results=await Promise.all([f.controller.execute(request,signature),f.controller.execute(request,signature)]);
  assert.deepEqual(f.signals,['pause']);assert.equal(results[0].receipt.resumeAt,results[1].receipt.resumeAt);
  f.advance(20000);await f.controller.execute(request,signature);assert.equal(f.controller.status().resumeAt,160000);
});
test('reusing an operation ID for another command is rejected',async()=>{
  const f=await fixture(),request=f.request();await f.controller.execute(request,signControl(request,f.keys.privateKey));
  const changed=f.request({operationId:request.operationId,action:'resume',durationMs:0});
  await assert.rejects(f.controller.execute(changed,signControl(changed,f.keys.privateKey)),/operation-conflict/);assert.deepEqual(f.signals,['pause']);
});
test('pause has a bounded automatic restoration even if the test driver disappears',async()=>{
  const f=await fixture(),request=f.request({durationMs:1000});await f.controller.execute(request,signControl(request,f.keys.privateKey));
  f.advance(999);await f.controller.sweep();assert.equal(f.controller.status().paused,true);
  f.advance(1);await f.controller.sweep();assert.equal(f.controller.status().paused,false);assert.deepEqual(f.signals,['pause','resume']);
});
test('controller restart restores the process and never replays a previous pause',async()=>{
  const f=await fixture(),request=f.request();await f.controller.execute(request,signControl(request,f.keys.privateKey));
  const recovered=await FaultController.create(f.config,f.target,f.store,f.clock);assert.equal(recovered.status().paused,false);assert.notEqual(recovered.status().generation,request.generation);
  await recovered.execute(request,signControl(request,f.keys.privateKey));assert.deepEqual(f.signals,['pause','resume']);assert.equal(recovered.status().paused,false);
});
test('pending signal operation survives recovery without another pause submission',async()=>{
  const f=await fixture(),request=f.request();const failing={pause:async()=>{throw new Error('interrupted');},resume:f.target.resume};
  const controller=await FaultController.create(f.config,failing,f.store,f.clock);
  const current={...request,generation:controller.status().generation};await assert.rejects(controller.execute(current,signControl(current,f.keys.privateKey)),/interrupted/);
  assert.equal(f.store.state?.receipts[0].state,'pending');
  const recovered=await FaultController.create(f.config,f.target,f.store,f.clock);const result=await recovered.execute(current,signControl(current,f.keys.privateKey));
  assert.equal(result.receipt.state,'pending');assert.deepEqual(f.signals,['resume']);
});
test('corrupt persisted receipts do not reset the replay journal',async()=>{
  const f=await fixture();f.store.state!.receipts=[{state:'bad'}] as unknown as ControlState['receipts'];
  await assert.rejects(FaultController.create(f.config,f.target,f.store,f.clock),/corrupt-control-state/);assert.deepEqual(f.signals,[]);
});

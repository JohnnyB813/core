import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {serialize,deserialize} from 'bson';
import {BootstrapUploader,validateUploadPlan,inspectBootstrap} from '../deploy/bootstrap-client.ts';
import type {UploadPlan,UploadJournal,UploadReceipt,UploadTarget} from '../deploy/bootstrap-client.ts';
import type {HpClient,HpKeys} from '../shared/hotpocket.ts';
import {FileUploadJournal} from '../deploy/upload-journal.ts';
const archive=Buffer.from('owned test zip fixture'),now=100000,owner='ed'+'a'.repeat(64),keys:HpKeys={publicKey:Buffer.from(owner,'hex'),privateKey:Buffer.alloc(65)};
const plan:UploadPlan={kind:'controller-bundle',operationId:'controller-upload-test-01',contractId:'11111111-2222-4333-8444-555555555555',target:{id:'c1',url:'wss://c1.example:32001/',serverKey:'ed'+'b'.repeat(64),lease:'C'.repeat(64),imageDigest:'sha256:'+'d'.repeat(64)},ownerPublicKey:owner,bundleHash:createHash('sha256').update(archive).digest('hex'),createdAt:now,expiresAt:now+20000};
function mock(mode:'ok'|'lost'|'disconnect'|'stale'='ok'){
  let sends=0,closeCount=0;const events=new Map<string,((...args:unknown[])=>void)[]>();
  const emit=(event:string,...args:unknown[])=>events.get(event)?.forEach(fn=>fn(...args));
  const client:HpClient&{getStatus:()=>Promise<{ledgerSeqNo:number}>}={
    connect:async()=>{emit('connection_change',plan.target.url,'add');return true;},close:async()=>{closeCount++;},on:(name,fn)=>{events.set(name,[...(events.get(name)||[]),fn]);},
    getStatus:async()=>({ledgerSeqNo:10}),
    submitContractReadRequest:async value=>{assert(value instanceof Uint8Array);assert.deepEqual(deserialize(Buffer.from(value)),{type:'status'});return serialize({type:'statusResult',status:'ok',message:'Bootstrap contract is online'});},
    submitContractInput:async value=>{sends++;assert(value instanceof Uint8Array);const input=deserialize(Buffer.from(value),{promoteBuffers:true});assert.equal(input.type,'upload');assert.deepEqual(input.content,archive);
      if(mode==='disconnect')emit('connection_change',plan.target.url,'remove');
      if(mode!=='lost')emit('contract_output',{ledgerSeqNo:mode==='stale'?10:11,outputs:[serialize({type:'uploadResult',status:'ok',message:'UploadSuccess'})]});
      return{hash:new Uint8Array(32),submissionStatus:Promise.resolve({status:'accepted'})};}
  };
  return{client,counts:()=>({sends,closeCount})};
}
function memoryJournal(){let claimed=false;const receipts:UploadReceipt[]=[];const journal:UploadJournal={get:async()=>structuredClone(plan),claim:async()=>{if(claimed)return false;claimed=true;return true;},record:async receipt=>{receipts.push(receipt);}};return{journal,receipts};}
test('bootstrap readiness requires the pinned BSON status without any contract input',async()=>{
  const m=mock();assert.deepEqual(await inspectBootstrap(plan.target,plan.contractId,keys,async()=>m.client),{bootstrapOnline:true,ledgerSeqNo:10,hpVersion:null,roundTime:null});
  assert.deepEqual(m.counts(),{sends:0,closeCount:1});
});
test('bootstrap input uses exact BSON framing and requires a new committed upload result',async()=>{
  const m=mock(),{journal,receipts}=memoryJournal();let pinned:UploadTarget|undefined,contractId:string|undefined;
  const uploader=new BootstrapUploader(journal,async(target,_keys,id)=>{pinned=target;contractId=id;return m.client;},()=>now,100);
  const receipt=await uploader.uploadOnce(plan.operationId,archive,keys);assert.equal(receipt.state,'applied');assert.deepEqual(pinned,plan.target);assert.equal(contractId,plan.contractId);assert.deepEqual(receipts.map(r=>r.state),['uncertain','applied']);assert.equal(m.counts().sends,1);assert.equal(m.counts().closeCount,1);
});
test('lost, stale or disconnected upload results leave a permanent claim without another input',async()=>{
  for(const mode of ['lost','stale','disconnect'] as const){const m=mock(mode),{journal,receipts}=memoryJournal();const create=async()=>m.client;const first=await new BootstrapUploader(journal,create,()=>now,30).uploadOnce(plan.operationId,archive,keys);assert.equal(first.state,'uncertain');const retry=await new BootstrapUploader(journal,create,()=>now,30).uploadOnce(plan.operationId,archive,keys);assert.equal(retry.state,'already-claimed');assert.equal(m.counts().sends,1);assert.deepEqual(receipts.map(r=>r.state),['uncertain']);}
});
test('wrong owner, substituted archive and expiry block an upload before any input',async()=>{
  const m=mock(),{journal}=memoryJournal(),uploader=new BootstrapUploader(journal,async()=>m.client,()=>now,100);
  await assert.rejects(uploader.uploadOnce(plan.operationId,Buffer.from('substituted'),keys));
  await assert.rejects(uploader.uploadOnce(plan.operationId,archive,{...keys,publicKey:Buffer.alloc(33)}));
  await assert.rejects(new BootstrapUploader(journal,async()=>m.client,()=>plan.expiresAt,100).uploadOnce(plan.operationId,archive,keys));
  assert.equal(m.counts().sends,0);
  assert.throws(()=>validateUploadPlan({...plan,target:{...plan.target,url:'ws://c1.example:32001/'}}));
});
test('durable bootstrap claims survive a new journal and uploader and corrupt receipts fail closed',async()=>{
  const parent=await realpath(tmpdir()),directory=await mkdtemp(join(parent,'warthog-upload-'));
  try{const journal=new FileUploadJournal(directory);await journal.create(plan);const m=mock('lost');assert.equal((await new BootstrapUploader(journal,async()=>m.client,()=>now,30).uploadOnce(plan.operationId,archive,keys)).state,'uncertain');const restored=new FileUploadJournal(directory);assert.equal((await restored.latest(plan.operationId))?.state,'uncertain');assert.equal((await new BootstrapUploader(restored,async()=>mock().client,()=>now,30).uploadOnce(plan.operationId,archive,keys)).state,'already-claimed');await writeFile(join(directory,plan.operationId+'.receipts.jsonl'),'partial');await assert.rejects(restored.latest(plan.operationId));}
  finally{const resolved=await realpath(directory);assert.equal(dirname(resolved),parent);assert(basename(resolved).startsWith('warthog-upload-'));await rm(resolved,{recursive:true});}
});

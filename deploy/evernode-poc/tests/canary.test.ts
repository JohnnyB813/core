import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {canaryPolicy,canaryPolicyHash,operationQuorum,mayExecuteCanary} from '../deploy/canary-policy.ts';
import type {CanaryPolicy,VerifiedOperationReply,OperationQuorum} from '../deploy/canary-policy.ts';
import {CanaryExecutor,validateCanaryBlob} from '../deploy/canary-executor.ts';
import type {CanaryJournal,CanaryLedger,SignedCanary,CanaryReceipt} from '../deploy/canary-executor.ts';
import {FileCanaryJournal} from '../deploy/canary-journal.ts';
import {stateHash} from '../controller/registry.ts';
import type {Snapshot} from '../controller/registry.ts';
const require=createRequire(import.meta.url),codec=require('xrpl-binary-codec-prerelease'),kp=require('ripple-keypairs');
// Ephemeral test-only wallet: its seed is never written, printed, or funded.
const pair=kp.deriveKeypair(kp.generateSeed({algorithm:'ecdsa-secp256k1'})),now=1800000000000,claimId=randomUUID();
const policy:CanaryPolicy={version:1,contractId:'11111111-2222-4333-8444-555555555555',operationId:randomUUID(),executorId:'g1',workerId:'w3',networkId:21337,canaryAccount:kp.deriveAddress(pair.publicKey),hostAccount:'rsAXRQGfLzuSumt5zXFhFadvK2wyWg9VA7',lease:'A'.repeat(64),rentEVR:'0.001',moments:1,maximumFeeDrops:1000,baselineExpiry:1800003600,notBefore:now-100,expiresAt:now+3600000};
const ids=['c1','c2','c3','c4','c5'];
function signed(overrides:Record<string,unknown>={}):SignedCanary{
 const tx={TransactionType:'Payment',Account:policy.canaryAccount,Destination:policy.hostAccount,Amount:{currency:'EVR',issuer:'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8',value:policy.rentEVR},Fee:'120',Sequence:10,LastLedgerSequence:125,NetworkID:21337,Memos:[],HookParameters:[{HookParameter:{HookParameterName:'4556520100000000000000000000000000000000000000000000000000000002',HookParameterValue:Buffer.from('evnExtendLease').toString('hex').toUpperCase()}},{HookParameter:{HookParameterName:'4556520100000000000000000000000000000000000000000000000000000003',HookParameterValue:policy.lease}}],SigningPubKey:pair.publicKey,...overrides};
 const signature=kp.sign(codec.encodeForSigning(tx),pair.privateKey),blob=codec.encode({...tx,TxnSignature:signature});
 return{blob,hash:createHash('sha512').update(Buffer.from('54584E00','hex')).update(Buffer.from(blob,'hex')).digest('hex').slice(0,64).toUpperCase()};
}
function replies():VerifiedOperationReply[]{
 const health:Snapshot={contractId:policy.contractId,sequence:50,committedAt:now-1,eligible:['w1','w2','w3'],probeHeight:5000000};
 return ids.map(controllerId=>({controllerId,observedAt:now,health:structuredClone(health),operation:{contractId:policy.contractId,sequence:50,committedAt:now-1,healthStateHash:stateHash(health),intent:{operationId:policy.operationId,policyHash:canaryPolicyHash(policy),authorizedAt:now-1000,notBefore:policy.notBefore,expiresAt:policy.expiresAt},claim:{claimId,claimedAt:now-50},result:null,maintenance:{revision:0,excludedWorkers:[]}}}));
}
const quorum=()=>operationQuorum(replies(),ids,policy.contractId,now)!;
function memoryJournal(){
 let payment:SignedCanary|null=null,prepared=false,dispatched=false;const receipts:CanaryReceipt[]=[];
 const journal:CanaryJournal={readSigned:async()=>payment,claimPreparation:async()=>{if(prepared)return false;prepared=true;return true;},saveSigned:async p=>{assert.equal(payment,null);payment=p;},wasDispatched:async()=>dispatched,claimDispatch:async()=>{if(dispatched)return false;dispatched=true;return true;},record:async r=>{receipts.push(r);}};
 return{journal,receipts};
}
function ledgerMock(){let prepares=0,submits=0,found=false,expiry=policy.baselineExpiry+3600;const payment=signed();
 const ledger:CanaryLedger={prepare:async()=>{prepares++;return payment;},ledgerIndex:async()=>100,submit:async blob=>{assert.equal(blob,payment.blob);submits++;throw new Error('Submission response lost');},find:async hash=>found?{hash,validated:true,ledger:110,result:'tesSUCCESS'}:null,hostExpiry:async()=>expiry};
 return{ledger,payment,counts:()=>({prepares,submits}),setFound:()=>{found=true;},setExpiry:(v:number)=>{expiry=v;}};
}
test('canary policy binds all fields and rejects extra permissions and unbounded spend',()=>{
 assert.equal(canaryPolicyHash(policy),canaryPolicyHash({...policy}));
 for(const bad of [{...policy,moments:2},{...policy,maximumFeeDrops:1001},{...policy,rentEVR:'1'},{...policy,networkId:0},{...policy,executorId:'g2'},{...policy,workerId:'w1'},{...policy,autoRenew:true},{...policy,expiresAt:policy.notBefore+43200001}])assert.throws(()=>canaryPolicy(bad));
});
test('operation quorum needs four distinct pinned identities agreeing on health and operation state',()=>{
 assert.equal(operationQuorum(replies().slice(0,4),ids,policy.contractId,now)?.controllers.length,4);
 assert.equal(operationQuorum(replies().slice(0,3),ids,policy.contractId,now),null);
 assert.equal(operationQuorum(Array(5).fill(replies()[0]),ids,policy.contractId,now),null);
 const mixed=replies();mixed[0].health.eligible=[];assert.equal(operationQuorum(mixed.slice(0,4),ids,policy.contractId,now),null);
 const stale=replies();for(const r of stale)r.observedAt=now-30001;assert.equal(operationQuorum(stale,ids,policy.contractId,now),null);
});
test('equivocation at one sequence removes that controller vote',()=>{
 const list=replies().slice(0,4),conflict=structuredClone(list[0]);conflict.operation.maintenance={revision:1,excludedWorkers:['w1']};
 assert.equal(operationQuorum([...list,conflict],ids,policy.contractId,now),null);
});
test('worker maintenance, the wrong claim, expiry and a completed operation prohibit new spending',()=>{
 const q=quorum();assert(mayExecuteCanary(policy,q,claimId,now));
 assert(!mayExecuteCanary(policy,q,randomUUID(),now));assert(!mayExecuteCanary(policy,q,claimId,policy.expiresAt));
 q.operation.maintenance={revision:1,excludedWorkers:['w3']};assert(!mayExecuteCanary(policy,q,claimId,now));
 q.operation.maintenance={revision:2,excludedWorkers:[]};q.operation.result={transactionHash:'a'.repeat(64),stage:'validated',conflict:false};assert(!mayExecuteCanary(policy,q,claimId,now));
});
test('offline signed canary blob is independently decoded, policy checked and signature verified',()=>{
 assert.deepEqual(validateCanaryBlob(policy,signed()),{sequence:10,lastLedgerSequence:125});
 for(const override of [{Fee:'1001'},{Destination:'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8'},{Amount:{currency:'EVR',issuer:'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8',value:'0.002'}},{Flags:131072},{NetworkID:21338}])assert.throws(()=>validateCanaryBlob(policy,signed(override)));
 const p=signed();assert.throws(()=>validateCanaryBlob(policy,{...p,hash:'B'.repeat(64)}));assert.throws(()=>validateCanaryBlob(policy,{...p,blob:p.blob.slice(0,-2)+'00'}));
});
test('duplicate calls and a new executor reconcile a lost response without another payment',async()=>{
 const m=memoryJournal(),l=ledgerMock(),create=()=>new CanaryExecutor(policy,claimId,m.journal,l.ledger,async()=>quorum(),()=>now);
 assert.equal((await create().runOnce()).state,'uncertain');assert.equal((await create().runOnce()).state,'uncertain');
 l.setFound();assert.equal((await create().runOnce()).state,'host-confirmed');assert.deepEqual(l.counts(),{prepares:1,submits:1});
 assert.deepEqual(m.receipts.map(r=>r.state),['uncertain','validated','host-confirmed']);
});
test('concurrent callers share one permanent preparation and dispatch claim',async()=>{
 const m=memoryJournal(),l=ledgerMock();const results=await Promise.all(Array.from({length:5},()=>new CanaryExecutor(policy,claimId,m.journal,l.ledger,async()=>quorum(),()=>now).runOnce()));
 assert(results.some(r=>r.state==='uncertain'));assert.deepEqual(l.counts(),{prepares:1,submits:1});
});
test('quorum lost during preparation saves the same blob and holds submission',async()=>{
 const m=memoryJournal(),l=ledgerMock();let fresh=true;const prepare=l.ledger.prepare;l.ledger.prepare=async p=>{const payment=await prepare(p);fresh=false;return payment;};
 const run=()=>new CanaryExecutor(policy,claimId,m.journal,l.ledger,async()=>fresh?quorum():null,()=>now).runOnce();
 assert.equal((await run()).state,'prepared-waiting');assert.deepEqual(l.counts(),{prepares:1,submits:0});
 fresh=true;assert.equal((await run()).state,'uncertain');assert.deepEqual(l.counts(),{prepares:1,submits:1});
});
test('an uncertain preparation claim or failed durable receipt never triggers a broadcast',async()=>{
 const m=memoryJournal(),l=ledgerMock();await m.journal.claimPreparation();
 assert.equal((await new CanaryExecutor(policy,claimId,m.journal,l.ledger,async()=>quorum(),()=>now).runOnce()).state,'preparation-claimed');assert.deepEqual(l.counts(),{prepares:0,submits:0});
 const second=memoryJournal();second.journal.record=async()=>{throw new Error('Receipt fsync failed');};
 await assert.rejects(new CanaryExecutor(policy,claimId,second.journal,l.ledger,async()=>quorum(),()=>now).runOnce());
 assert.equal((await new CanaryExecutor(policy,claimId,second.journal,l.ledger,async()=>null,()=>now).runOnce()).state,'uncertain');assert.deepEqual(l.counts(),{prepares:1,submits:0});
});
test('validation without the exact host expiry increment remains unconfirmed',async()=>{
 const m=memoryJournal(),l=ledgerMock();l.setFound();l.setExpiry(policy.baselineExpiry+7200);
 assert.equal((await new CanaryExecutor(policy,claimId,m.journal,l.ledger,async()=>quorum(),()=>now).runOnce()).state,'validated');
});
test('private file claims survive a new journal, and changed policy or corrupt payment fails closed',async()=>{
 const parent=await realpath(tmpdir()),directory=await mkdtemp(join(parent,'warthog-canary-'));
 try{
  const j=await FileCanaryJournal.open(directory,policy,claimId),l=ledgerMock();
  assert.equal((await new CanaryExecutor(policy,claimId,j,l.ledger,async()=>quorum(),()=>now).runOnce()).state,'uncertain');
  const restored=await FileCanaryJournal.open(directory,policy,claimId);l.setFound();
  assert.equal((await new CanaryExecutor(policy,claimId,restored,l.ledger,async()=>null,()=>now).runOnce()).state,'host-confirmed');assert.deepEqual(l.counts(),{prepares:1,submits:1});
  await assert.rejects(FileCanaryJournal.open(directory,{...policy,rentEVR:'0.002'},claimId));
  await writeFile(join(directory,'payment.json'),'partial');await assert.rejects(restored.readSigned());
 }finally{const resolved=await realpath(directory);assert.equal(dirname(resolved),parent);assert(basename(resolved).startsWith('warthog-canary-'));await rm(resolved,{recursive:true});}
});

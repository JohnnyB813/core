import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {XahauCanaryLedger} from '../deploy/canary-ledger.ts';
import type {CanarySession,CanaryHostBinding} from '../deploy/canary-ledger.ts';
import {validateCanaryBlob} from '../deploy/canary-executor.ts';
import type {CanaryPolicy} from '../deploy/canary-policy.ts';
const require=createRequire(import.meta.url),keypairs=require('ripple-keypairs');
function fixture(){
  const keys=keypairs.deriveKeypair(keypairs.generateSeed()),other=keypairs.deriveKeypair(keypairs.generateSeed());
  const policy:CanaryPolicy={version:1,contractId:'11111111-2222-4333-8444-555555555555',operationId:'22222222-2222-4222-8222-222222222222',executorId:'g1',workerId:'w3',networkId:21337,canaryAccount:keypairs.deriveAddress(keys.publicKey),hostAccount:keypairs.deriveAddress(other.publicKey),lease:'A'.repeat(64),rentEVR:'0.001',moments:1,maximumFeeDrops:1000,baselineExpiry:200000,notBefore:0,expiresAt:200000};
  const host:CanaryHostBinding={origin:'https://worker.example',userPort:30123,controlOrigin:'https://worker.example:30135',generation:'33333333-3333-4333-8333-333333333333',volumeId:'44444444-4444-4444-8444-444444444444',imageDigest:'sha256:'+'a'.repeat(64)};
  const state={owner:policy.canaryAccount,issuer:policy.hostAccount,expiry:policy.baselineExpiry,generation:host.generation,networkId:21337,fee:'120',preparations:0,submissions:[]as string[],lostResponse:false,closed:false};
  const session:CanarySession={
    lease:async()=>({Owner:state.owner,Issuer:state.issuer}),
    prepare:async()=>{state.preparations++;return{TransactionType:'Payment',Account:policy.canaryAccount,Destination:policy.hostAccount,NetworkID:state.networkId,Amount:{currency:'EVR',issuer:'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8',value:policy.rentEVR},Fee:state.fee,Sequence:3,LastLedgerSequence:1020,Memos:[],HookParameters:[{HookParameter:{HookParameterName:'4556520100000000000000000000000000000000000000000000000000000002',HookParameterValue:Buffer.from('evnExtendLease').toString('hex').toUpperCase()}},{HookParameter:{HookParameterName:'4556520100000000000000000000000000000000000000000000000000000003',HookParameterValue:policy.lease}}]};},
    ledgerIndex:async()=>1000,
    submit:async blob=>{state.submissions.push(blob);if(state.lostResponse)throw new Error('Fixture lost response');},
    transaction:async hash=>({hash,TransactionType:'Payment',Account:policy.canaryAccount,Destination:policy.hostAccount,validated:true,ledger_index:1001,meta:{TransactionResult:'tesSUCCESS'}}),
    close:async()=>{state.closed=true;}
  };
  const reads:string[]=[];
  const reader=async(url:string)=>{reads.push(url);if(url.endsWith('/api-sashilist'))return{sashiList:[{name:'masked',image:'masked',user_port:host.userPort,gp_tcp_port:30135,imageDigest:'@'+host.imageDigest,status:'active',expiry_timestamp:state.expiry}]};return{contractId:policy.contractId,targetId:'w3',generation:state.generation,observations:{applicationRunning:true,resources:{volumeId:host.volumeId}}};};
  return{policy,keys,host,state,session,reader,reads,ledger:new XahauCanaryLedger(policy,keys,host,session,reader,()=>100000)};
}
test('limited signer prepares the exact independently decoded payment and dispatches once after a lost response',async()=>{
  const f=fixture(),payment=await f.ledger.prepare(f.policy);assert.equal(validateCanaryBlob(f.policy,payment).sequence,3);assert.equal(f.state.preparations,1);assert.equal(await f.ledger.ledgerIndex(),1000);
  f.state.lostResponse=true;await assert.rejects(f.ledger.submit(payment.blob));await assert.rejects(f.ledger.submit(payment.blob),/closed/);assert.equal(f.state.submissions.length,1);
  assert.deepEqual(await f.ledger.find(payment.hash),{hash:payment.hash,validated:true,ledger:1001,result:'tesSUCCESS'});
  f.state.expiry+=3600;assert.equal(await f.ledger.hostExpiry(),f.policy.baselineExpiry+3600);assert(f.reads.every(u=>['https://worker.example/api-sashilist','https://worker.example:30135/pilot/status'].includes(u)));
  await f.ledger.close();assert(f.state.closed);await assert.rejects(f.ledger.prepare(f.policy),/outside policy/);
});
test('lease ownership, issuer and exact baseline must match before unsigned preparation',async()=>{
  for(const field of ['owner','issuer','expiry']as const){const f=fixture();if(field==='expiry')f.state.expiry++;else f.state[field]='different';await assert.rejects(f.ledger.prepare(f.policy),/owner or baseline/);assert.equal(f.state.preparations,0);assert.equal(f.state.submissions.length,0);}
});
test('independent decoding rejects unsafe SDK network and fee output before dispatch',async()=>{
  for(const field of ['networkId','fee']){const f=fixture();if(field==='networkId')f.state.networkId=21338;else f.state.fee='1001';await assert.rejects(f.ledger.prepare(f.policy),/policy/);assert.equal(f.state.submissions.length,0);}
});
test('a replaced worker generation or malformed binding cannot confirm the old lease',async()=>{
  const f=fixture();f.state.generation='55555555-5555-4555-8555-555555555555';assert.equal(await f.ledger.hostExpiry(),null);await assert.rejects(f.ledger.prepare(f.policy));
  for(const changed of [{origin:'http://worker.example'},{controlOrigin:'https://foreign.example:30135'},{origin:'https://user:password@worker.example'}])assert.throws(()=>new XahauCanaryLedger(f.policy,f.keys,{...f.host,...changed},f.session,f.reader));
  const another=keypairs.deriveAddress(keypairs.deriveKeypair(keypairs.generateSeed()).publicKey);
  assert.throws(()=>new XahauCanaryLedger({...f.policy,canaryAccount:another},f.keys,f.host,f.session,f.reader),/signer differs/);
});

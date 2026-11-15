import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {PresignedCanaryLedger} from '../deploy/canary-presigned.ts';
import type {CanaryPolicy} from '../deploy/canary-policy.ts';
import type {CanaryHostBinding} from '../deploy/canary-host.ts';
import type {CanaryRpcCommand} from '../deploy/canary-rpc.ts';
const require=createRequire(import.meta.url),pairs=require('ripple-keypairs'),codec=require('xrpl-binary-codec-prerelease');
function fixture(){
  const key=pairs.deriveKeypair(pairs.generateSeed()),hostKey=pairs.deriveKeypair(pairs.generateSeed());
  const policy:CanaryPolicy={version:1,contractId:'11111111-2222-4333-8444-555555555555',operationId:'22222222-2222-4222-8222-222222222222',executorId:'g1',workerId:'w3',networkId:21337,canaryAccount:pairs.deriveAddress(key.publicKey),hostAccount:pairs.deriveAddress(hostKey.publicKey),lease:'A'.repeat(64),rentEVR:'0.001',moments:1,maximumFeeDrops:1000,baselineExpiry:200000,notBefore:0,expiresAt:200000};
  const tx={TransactionType:'Payment',Account:policy.canaryAccount,Destination:policy.hostAccount,NetworkID:21337,Amount:{currency:'EVR',issuer:'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8',value:'0.001'},Fee:'120',Sequence:3,LastLedgerSequence:1020,Memos:[],SigningPubKey:key.publicKey,HookParameters:[{HookParameter:{HookParameterName:'4556520100000000000000000000000000000000000000000000000000000002',HookParameterValue:Buffer.from('evnExtendLease').toString('hex').toUpperCase()}},{HookParameter:{HookParameterName:'4556520100000000000000000000000000000000000000000000000000000003',HookParameterValue:policy.lease}}]};
  const blob=codec.encode({...tx,TxnSignature:pairs.sign(codec.encodeForSigning(tx),key.privateKey)}),payment={blob,hash:createHash('sha512').update(Buffer.from('54584E00','hex')).update(Buffer.from(blob,'hex')).digest('hex').slice(0,64).toUpperCase()};
  const host:CanaryHostBinding={origin:'https://worker.example',userPort:30123,controlOrigin:'https://worker.example:30135',generation:'33333333-3333-4333-8333-333333333333',volumeId:'44444444-4444-4444-8444-444444444444',imageDigest:'sha256:'+'a'.repeat(64)};
  const state={owner:policy.canaryAccount,expiry:policy.baselineExpiry,lostResponse:false,now:100000},commands:CanaryRpcCommand[]=[];
  const rpc=async(command:CanaryRpcCommand)=>{commands.push(command);switch(command.command){case'ledger_entry':return{node:{LedgerEntryType:'URIToken',Owner:state.owner,Issuer:policy.hostAccount}};case'ledger_current':return{ledger_current_index:1000};case'submit':if(state.lostResponse)throw new Error('Lost response');return{};case'tx':return{...tx,hash:payment.hash,validated:true,ledger_index:1001,meta:{TransactionResult:'tesSUCCESS'}};}};
  const reader=async(url:string)=>url.endsWith('/api-sashilist')?{sashiList:[{user_port:30123,gp_tcp_port:30135,imageDigest:'@'+host.imageDigest,status:'active',expiry_timestamp:state.expiry}]}:{contractId:policy.contractId,targetId:'w3',generation:host.generation,observations:{applicationRunning:true,resources:{volumeId:host.volumeId}}};
  return{policy,payment,host,state,commands,ledger:new PresignedCanaryLedger(policy,payment,host,rpc,reader,()=>state.now)};
}
test('offsite adapter needs only the fixed signed payment, and never resends after a lost response',async()=>{
  const f=fixture();assert.deepEqual(await f.ledger.prepare(f.policy),f.payment);assert.equal(await f.ledger.ledgerIndex(),1000);f.state.lostResponse=true;await assert.rejects(f.ledger.submit(f.payment.blob));await assert.rejects(f.ledger.submit(f.payment.blob),/closed/);assert.equal(f.commands.filter(c=>c.command==='submit').length,1);
  assert.equal((await f.ledger.find(f.payment.hash))?.result,'tesSUCCESS');f.state.expiry+=3600;assert.equal(await f.ledger.hostExpiry(),f.policy.baselineExpiry+3600);
});
test('a changed policy, lease owner, baseline or time window cannot prepare dispatch',async()=>{
  for(const change of ['policy','owner','expiry','window']){const f=fixture();if(change==='owner')f.state.owner='other';if(change==='expiry')f.state.expiry++;if(change==='window')f.state.now=f.policy.expiresAt;await assert.rejects(f.ledger.prepare(change==='policy'?{...f.policy,rentEVR:'0.002'}:f.policy));assert.equal(f.commands.filter(c=>c.command==='submit').length,0);}
});
test('a different blob or lookup hash cannot use the fixed payment capability',async()=>{
  const f=fixture();await assert.rejects(f.ledger.submit(f.payment.blob.slice(0,-2)+'00'));await assert.rejects(f.ledger.find('B'.repeat(64)));assert.equal(f.commands.length,0);
});

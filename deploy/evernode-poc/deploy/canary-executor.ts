import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {object} from '../shared/health.ts';
import {canaryPolicy,canaryPolicyHash,mayExecuteCanary} from './canary-policy.ts';
import type {CanaryPolicy,OperationQuorum} from './canary-policy.ts';
export type SignedCanary={blob:string;hash:string};
export type CanaryReceipt={state:'uncertain'|'validated'|'host-confirmed'|'failed';at:number;hash:string;ledger?:number;result?:string;expiryTimestamp?:number};
export interface CanaryJournal{
 readSigned:()=>Promise<SignedCanary|null>;
 claimPreparation:()=>Promise<boolean>;
 saveSigned:(payment:SignedCanary)=>Promise<void>;
 wasDispatched:()=>Promise<boolean>;
 claimDispatch:()=>Promise<boolean>;
 record:(receipt:CanaryReceipt)=>Promise<void>;
}
export interface CanaryLedger{
 // Preparation and signing are local. No adapter may submit from this method.
 prepare:(policy:CanaryPolicy)=>Promise<SignedCanary>;
 ledgerIndex:()=>Promise<number>;
 submit:(blob:string)=>Promise<void>;
 find:(hash:string)=>Promise<{hash:string;validated:boolean;ledger:number;result:string}|null>;
 hostExpiry:()=>Promise<number|null>;
}
const issuer='rEvernodee8dJLaFsujS6q1EiXvZYmHXr8';
const eventName='4556520100000000000000000000000000000000000000000000000000000002',eventData='4556520100000000000000000000000000000000000000000000000000000003';
export function validateCanaryBlob(raw:CanaryPolicy,payment:SignedCanary):{sequence:number;lastLedgerSequence:number}{
 const policy=canaryPolicy(raw);
 if(Object.keys(payment).sort().join(',')!=='blob,hash'||typeof payment.blob!=='string'||!(/^(?:[A-F0-9]{2}){100,8192}$/).test(payment.blob)||!(/^[A-F0-9]{64}$/).test(payment.hash))throw new Error('Invalid signed canary journal');
 const expected=createHash('sha512').update(Buffer.from('54584E00','hex')).update(Buffer.from(payment.blob,'hex')).digest('hex').slice(0,64).toUpperCase();
 if(expected!==payment.hash)throw new Error('Canary transaction hash differs');
 const require=createRequire(import.meta.url),codec=require('xrpl-binary-codec-prerelease'),keypairs=require('ripple-keypairs'),tx=object(codec.decode(payment.blob));
 const fields=['TransactionType','Account','Destination','Amount','Fee','Sequence','LastLedgerSequence','NetworkID','HookParameters','Memos','SigningPubKey','TxnSignature'];
 if(Object.keys(tx).sort().join(',')!==fields.sort().join(',')||tx.TransactionType!=='Payment'||tx.Account!==policy.canaryAccount||tx.Destination!==policy.hostAccount||tx.NetworkID!==policy.networkId||typeof tx.Fee!=='string'||!(/^[1-9][0-9]*$/).test(tx.Fee)||Number(tx.Fee)>policy.maximumFeeDrops||!Number.isSafeInteger(tx.Sequence)||Number(tx.Sequence)<1||Number(tx.Sequence)>0xffffffff||!Number.isSafeInteger(tx.LastLedgerSequence)||Number(tx.LastLedgerSequence)<1||Number(tx.LastLedgerSequence)>0xffffffff||!Array.isArray(tx.Memos)||tx.Memos.length!==0||!Array.isArray(tx.HookParameters)||tx.HookParameters.length!==2||typeof tx.SigningPubKey!=='string'||!(/^(02|03)[A-F0-9]{64}$/).test(tx.SigningPubKey)||typeof tx.TxnSignature!=='string'||keypairs.deriveAddress(tx.SigningPubKey)!==policy.canaryAccount)throw new Error('Signed payment exceeds the immutable canary policy');
 const amount=object(tx.Amount);if(Object.keys(amount).sort().join(',')!=='currency,issuer,value'||amount.currency!=='EVR'||amount.issuer!==issuer||amount.value!==policy.rentEVR)throw new Error('Canary rent differs');
 const hooks=new Map<string,string>();for(const entry of tx.HookParameters){const wrapper=object(entry),parameter=object(wrapper.HookParameter);if(Object.keys(wrapper).join(',')!=='HookParameter'||Object.keys(parameter).sort().join(',')!=='HookParameterName,HookParameterValue'||typeof parameter.HookParameterName!=='string'||typeof parameter.HookParameterValue!=='string'||hooks.has(parameter.HookParameterName))throw new Error('Invalid canary lease event');hooks.set(parameter.HookParameterName,parameter.HookParameterValue);}
 if(hooks.get(eventName)!==Buffer.from('evnExtendLease').toString('hex').toUpperCase()||hooks.get(eventData)!==policy.lease)throw new Error('Canary lease event differs');
 const signing={...tx};delete signing.TxnSignature;
 if(!keypairs.verify(codec.encodeForSigning(signing),tx.TxnSignature,tx.SigningPubKey))throw new Error('Canary signature is invalid');
 return{sequence:Number(tx.Sequence),lastLedgerSequence:Number(tx.LastLedgerSequence)};
}
/** Exactly one bounded payment, with a permanent dispatch claim before submit.
 * A missing response is reconciled by the saved hash; it never causes a new
 * payment or a second broadcast, including after a new process is created. */
export class CanaryExecutor{
 #policy:CanaryPolicy;#claimId:string;#journal:CanaryJournal;#ledger:CanaryLedger;#quorum:()=>Promise<OperationQuorum|null>;#now:()=>number;
 constructor(policy:CanaryPolicy,claimId:string,journal:CanaryJournal,ledger:CanaryLedger,quorum:()=>Promise<OperationQuorum|null>,now:()=>number=Date.now){
  this.#policy=canaryPolicy(policy);if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(claimId))throw new Error('Invalid committed canary claim');this.#claimId=claimId;this.#journal=journal;this.#ledger=ledger;this.#quorum=quorum;this.#now=now;
 }
 async #reconcile(payment:SignedCanary):Promise<CanaryReceipt>{
  const pending:CanaryReceipt={state:'uncertain',hash:payment.hash,at:this.#now()};let found;
  try{found=await this.#ledger.find(payment.hash);}catch{return pending;}
  if(!found?.validated||found.hash!==payment.hash||!Number.isSafeInteger(found.ledger)||found.ledger<1)return pending;
  const receipt:CanaryReceipt={...pending,state:found.result==='tesSUCCESS'?'validated':'failed',ledger:found.ledger,result:found.result};
  await this.#journal.record(receipt);
  if(receipt.state==='validated'){
   let expiry:number|null=null;try{expiry=await this.#ledger.hostExpiry();}catch{}
   if(expiry===this.#policy.baselineExpiry+3600){const confirmed:CanaryReceipt={...receipt,state:'host-confirmed',expiryTimestamp:expiry};await this.#journal.record(confirmed);return confirmed;}
  }
  return receipt;
 }
 async runOnce():Promise<CanaryReceipt|{state:'not-authorized'|'preparation-claimed'|'prepared-waiting';policyHash:string}>{
  const policy=this.#policy,policyHash=canaryPolicyHash(policy);let payment=await this.#journal.readSigned();
  if(payment){validateCanaryBlob(policy,payment);if(await this.#journal.wasDispatched())return this.#reconcile(payment);}
  const authorized=async()=>mayExecuteCanary(policy,await this.#quorum(),this.#claimId,this.#now());
  if(!await authorized())return{state:'not-authorized',policyHash};
  if(!payment){
   if(!await this.#journal.claimPreparation())return{state:'preparation-claimed',policyHash};
   payment=await this.#ledger.prepare(policy);validateCanaryBlob(policy,payment);await this.#journal.saveSigned(payment);
  }
  const details=validateCanaryBlob(policy,payment),ledger=await this.#ledger.ledgerIndex();
  if(!Number.isSafeInteger(ledger)||ledger<1||details.lastLedgerSequence<=ledger||details.lastLedgerSequence-ledger>40||!await authorized())return{state:'prepared-waiting',policyHash};
  if(!await this.#journal.claimDispatch())return this.#reconcile(payment);
  await this.#journal.record({state:'uncertain',hash:payment.hash,at:this.#now()});
  try{await this.#ledger.submit(payment.blob);}catch{/* Reconcile the saved hash; never submit again. */}
  return this.#reconcile(payment);
 }
}

import {createHash} from 'node:crypto';
import {serialize,deserialize} from 'bson';
import {loadHotPocket} from '../shared/hotpocket.ts';
import type {HpClient,HpKeys} from '../shared/hotpocket.ts';
import {object} from '../shared/health.ts';

export type UploadTarget={id:string;url:string;serverKey:string;lease:string;imageDigest:string};
export type UploadPlan={kind:'controller-bundle';operationId:string;contractId:string;target:UploadTarget;ownerPublicKey:string;bundleHash:string;createdAt:number;expiresAt:number};
export type UploadReceipt={operationId:string;state:'uncertain'|'applied';at:number;ledger?:number};
export interface UploadJournal{get:(id:string)=>Promise<UploadPlan>;claim:(id:string)=>Promise<boolean>;record:(receipt:UploadReceipt)=>Promise<void>;}
type BootstrapClient=HpClient&{getStatus:()=>Promise<{ledgerSeqNo?:number}>};
type Factory=(target:UploadTarget,keys:HpKeys,contractId:string)=>Promise<BootstrapClient>;
export function uploadTarget(value:UploadTarget):UploadTarget{
  const url=new URL(value.url);
  if(Object.keys(value).sort().join(',')!=='id,imageDigest,lease,serverKey,url'||!/^c[1-5]$/.test(value.id)||url.protocol!=='wss:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!url.port||!/^ed[0-9a-f]{64}$/i.test(value.serverKey)||!(/^[A-F0-9]{64}$/).test(value.lease)||!/^sha256:[a-f0-9]{64}$/.test(value.imageDigest))throw new Error('Invalid pinned bootstrap target');
  return{...value,url:url.href};
}
export function validateUploadPlan(value:UploadPlan):UploadPlan{
  if(Object.keys(value).sort().join(',')!=='bundleHash,contractId,createdAt,expiresAt,kind,operationId,ownerPublicKey,target'||value.kind!=='controller-bundle'||!(/^[a-z0-9-]{12,80}$/).test(value.operationId)||!(/^[a-f0-9-]{36}$/).test(value.contractId)||!/^ed[0-9a-f]{64}$/i.test(value.ownerPublicKey)||!/^\w{64}$/.test(value.bundleHash)||!/^[a-f0-9]{64}$/.test(value.bundleHash)||!Number.isSafeInteger(value.createdAt)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=value.createdAt||value.expiresAt-value.createdAt>1200000)throw new Error('Invalid immutable upload plan');
  return{...value,target:uploadTarget(value.target)};
}
function decode(value:unknown):{type:string;status:string;message:string}{
  if(!(value instanceof Uint8Array)||value.byteLength>65536)throw new Error('Invalid bootstrap response');
  const body=object(deserialize(Buffer.from(value)));
  if(Object.keys(body).sort().join(',')!=='message,status,type'||typeof body.type!=='string'||typeof body.status!=='string'||typeof body.message!=='string'||body.message.length>256)throw new Error('Invalid bootstrap response');
  return body as {type:string;status:string;message:string};
}
async function deadline<T>(operation:Promise<T>,timeoutMs:number):Promise<T>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([operation,new Promise<T>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Bootstrap deadline exceeded')),timeoutMs);})]);}finally{clearTimeout(timer);}}
async function factory(target:UploadTarget,keys:HpKeys,contractId:string):Promise<BootstrapClient>{
  const hp=loadHotPocket();
  return await hp.createClient([target.url],keys,{protocol:'bson',contractId,trustedServerKeys:[target.serverKey],requiredConnectionCount:1,connectionTimeoutMs:3000}) as BootstrapClient;
}
/** One owner-signed bootstrap upload. A lost result is never retried here. */
export class BootstrapUploader{
  #journal:UploadJournal;#factory:Factory;#now:()=>number;#timeout:number;
  constructor(journal:UploadJournal,create:Factory=factory,now:()=>number=Date.now,timeoutMs=45000){if(!Number.isInteger(timeoutMs)||timeoutMs<20||timeoutMs>60000)throw new Error('Invalid upload timeout');this.#journal=journal;this.#factory=create;this.#now=now;this.#timeout=timeoutMs;}
  async uploadOnce(operationId:string,archive:Buffer,keys:HpKeys):Promise<UploadReceipt|{state:'already-claimed';operationId:string}>{
    const plan=validateUploadPlan(await this.#journal.get(operationId)),now=this.#now();
    if(now<plan.createdAt||now>=plan.expiresAt||archive.length<1||archive.length>131072||createHash('sha256').update(archive).digest('hex')!==plan.bundleHash||Buffer.from(keys.publicKey).toString('hex')!==plan.ownerPublicKey)throw new Error('Upload no longer matches its reviewed plan');
    let client:BootstrapClient|undefined,invalid=false,closing=false,connections=0,claimed=false;
    try{
      client=await this.#factory(plan.target,keys,plan.contractId);
      client.on('connection_change',(server,change)=>{if(closing)return;if(server!==plan.target.url||change==='remove'||change==='add'&&++connections>1){invalid=true;closing=true;void client?.close();}});
      if(!await deadline(client.connect(),this.#timeout)||invalid)throw new Error('Pinned bootstrap connection unavailable');
      const status=decode(await deadline(client.submitContractReadRequest(serialize({type:'status'}),'bootstrap-status',3000),this.#timeout));
      if(invalid||status.type!=='statusResult'||status.status!=='ok'||status.message!=='Bootstrap contract is online')throw new Error('Pinned bootstrap contract is not ready');
      const current=await deadline(client.getStatus(),3000),baseline=current.ledgerSeqNo;
      if(!Number.isSafeInteger(baseline)||Number(baseline)<0||invalid)throw new Error('Bootstrap ledger is unavailable');
      const mutationTime=this.#now();if(mutationTime<plan.createdAt||mutationTime>=plan.expiresAt)throw new Error('Upload plan expired before submission');
      if(!await this.#journal.claim(operationId))return{state:'already-claimed',operationId};
      claimed=true;
      await this.#journal.record({operationId,state:'uncertain',at:this.#now()});
      let acceptedLedger:number|undefined;
      const applied=new Promise<number>((resolve)=>{
        client!.on('contract_output',value=>{if(invalid)return;try{const event=object(value);if(!Number.isSafeInteger(event.ledgerSeqNo)||Number(event.ledgerSeqNo)<=Number(baseline)||!Array.isArray(event.outputs)||event.outputs.length>20)return;for(const output of event.outputs){const body=decode(output);if(body.type==='uploadResult'&&body.status==='ok'&&body.message==='UploadSuccess'){acceptedLedger=Number(event.ledgerSeqNo);resolve(acceptedLedger);}}}catch{}});
      });
      const submission=await deadline(client.submitContractInput(serialize({type:'upload',content:archive}),this.#now(),10,true),this.#timeout);
      const result=await deadline(submission.submissionStatus,this.#timeout);
      if(result.status!=='accepted'||invalid)throw new Error('Bootstrap input was not acknowledged on the pinned connection');
      const ledger=await deadline(applied,this.#timeout);
      if(invalid||acceptedLedger!==ledger)throw new Error('Pinned bootstrap output unavailable');
      const receipt:UploadReceipt={operationId,state:'applied',at:this.#now(),ledger};await this.#journal.record(receipt);return receipt;
    }catch(error){if(!claimed)throw error;return{operationId,state:'uncertain',at:this.#now()};}
    finally{closing=true;if(client)await deadline(client.close().catch(()=>{}),500).catch(()=>{});}
  }
}

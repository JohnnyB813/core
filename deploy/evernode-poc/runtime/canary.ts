import {mkdir,open,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {object} from '../shared/health.ts';
import {operationId} from '../controller/operations.ts';
import {canaryPolicy,canaryPolicyHash} from '../deploy/canary-policy.ts';
import type {CanaryPolicy,OperationQuorum} from '../deploy/canary-policy.ts';
import {canaryHostBinding} from '../deploy/canary-host.ts';
import type {CanaryHostBinding} from '../deploy/canary-host.ts';
import {CanaryExecutor,validateCanaryBlob} from '../deploy/canary-executor.ts';
import type {CanaryLedger,CanaryReceipt,SignedCanary} from '../deploy/canary-executor.ts';
import {FileCanaryJournal} from '../deploy/canary-journal.ts';
import {PresignedCanaryLedger} from '../deploy/canary-presigned.ts';
export type CanaryCapability={policy:CanaryPolicy;claimId:string;payment:SignedCanary;host:CanaryHostBinding};
export function parseCanaryCapability(raw:unknown):CanaryCapability{
  const b=object(raw);if(Object.keys(b).sort().join(',')!=='claimId,host,payment,policy'||!operationId(b.claimId))throw new Error('Invalid finite canary capability');
  const policy=canaryPolicy(b.policy),payment=object(b.payment) as SignedCanary,host=canaryHostBinding(b.host as CanaryHostBinding);
  validateCanaryBlob(policy,payment);return{policy,claimId:b.claimId,payment:structuredClone(payment),host};
}
type InputSender=(body:Record<string,unknown>)=>Promise<boolean>;
type Status={state:string;policyHash:string;claimAttempted:boolean;dispatchClaimed:boolean;receipt:CanaryReceipt|null;updatedAt:number};
export class CanaryService{
  #c:CanaryCapability;#directory:string;#ledger:CanaryLedger;#quorum:()=>Promise<OperationQuorum|null>;#send:InputSender;#now:()=>number;#journal:FileCanaryJournal|undefined;#executor:CanaryExecutor|undefined;#busy=false;#done=false;#state:Status;
  constructor(capability:CanaryCapability,directory:string,quorum:()=>Promise<OperationQuorum|null>,send:InputSender,ledger?:CanaryLedger,now:()=>number=Date.now){
    this.#c=parseCanaryCapability(capability);this.#directory=directory;this.#ledger=ledger||new PresignedCanaryLedger(this.#c.policy,this.#c.payment,this.#c.host);this.#quorum=quorum;this.#send=send;this.#now=now;
    this.#state={state:'waiting',policyHash:canaryPolicyHash(this.#c.policy),claimAttempted:false,dispatchClaimed:false,receipt:null,updatedAt:now()};
  }
  status():Status{return structuredClone(this.#state);}
  async #claim(name:string):Promise<boolean>{
    await mkdir(this.#directory,{recursive:true,mode:0o700});const meta=await lstat(this.#directory);if(!meta.isDirectory()||process.platform!=='win32'&&(meta.mode&0o077)!==0)throw new Error('Private canary service state required');
    let f;try{f=await open(join(this.#directory,name),'wx',0o600);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')return false;throw e;}
    try{await f.writeFile(JSON.stringify({policyHash:this.#state.policyHash,claimId:this.#c.claimId}));await f.sync();}finally{await f.close();}
    if(process.platform!=='win32'){const d=await open(this.#directory,'r');try{await d.sync();}finally{await d.close();}}return true;
  }
  async tick():Promise<void>{
    if(this.#busy||this.#done)return;this.#busy=true;
    try{
      if(!this.#journal){this.#journal=await FileCanaryJournal.open(join(this.#directory,'payment'),this.#c.policy,this.#c.claimId);this.#executor=new CanaryExecutor(this.#c.policy,this.#c.claimId,this.#journal,this.#ledger,this.#quorum,this.#now);}
      // A dispatch already claimed on disk must be reconciled even after the
      // authorization expires, the process restarts, or quorum is lost.
      this.#state.dispatchClaimed=await this.#journal.wasDispatched();
      if(!this.#state.dispatchClaimed){
        const q=await this.#quorum(),p=this.#c.policy,now=this.#now();
        if(now>=p.expiresAt){this.#state.state='expired-without-dispatch';this.#done=true;return;}
        if(!q||now<p.notBefore||!q.operation.intent||q.operation.intent.policyHash!==this.#state.policyHash||q.operation.intent.operationId!==p.operationId||!q.health.eligible.includes('w3')||q.operation.maintenance.excludedWorkers.includes('w3')){this.#state.state='waiting-for-quorum';return;}
        if(!q.operation.claim){
          this.#state.claimAttempted=true;
          if(await this.#claim('contract-input.claim'))await this.#send({type:'canary-claim',operationId:p.operationId,policyHash:this.#state.policyHash,claimId:this.#c.claimId});
          this.#state.state='waiting-for-committed-claim';return;
        }
        if(q.operation.claim.claimId!==this.#c.claimId){this.#state.state='claim-conflict';this.#done=true;return;}
      }
      const result=await this.#executor!.runOnce();this.#state.state=result.state;
      this.#state.dispatchClaimed=await this.#journal.wasDispatched();
      if('hash'in result){this.#state.receipt=result;if(result.state==='host-confirmed'||result.state==='failed'){
        if(result.state==='host-confirmed'&&await this.#claim('result-input.claim'))await this.#send({type:'canary-result',operationId:this.#c.policy.operationId,claimId:this.#c.claimId,transactionHash:result.hash.toLowerCase(),stage:'host-confirmed'});
        this.#done=true;
      }}
    }finally{this.#state.updatedAt=this.#now();this.#busy=false;}
  }
}

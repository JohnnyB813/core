import {object} from '../shared/health.ts';
import {canaryPolicy,canaryPolicyHash} from './canary-policy.ts';
import {validateCanaryBlob} from './canary-executor.ts';
import {canaryHostBinding,observeCanaryHost} from './canary-host.ts';
import {createCanaryRpc} from './canary-rpc.ts';
import type {CanaryPolicy} from './canary-policy.ts';
import type {CanaryHostBinding,CanaryJsonReader} from './canary-host.ts';
import type {CanaryLedger,SignedCanary} from './canary-executor.ts';
import type {CanaryRpc} from './canary-rpc.ts';

/** The offsite trial receives one immutable, locally signed payment rather
 * than a wallet signing key. Its ledger expiry also limits delayed replay. */
export class PresignedCanaryLedger implements CanaryLedger{
  #policy:CanaryPolicy;#payment:SignedCanary;#host:CanaryHostBinding;#rpc:CanaryRpc;#reader:CanaryJsonReader|undefined;#now:()=>number;#submitted=false;
  constructor(policy:CanaryPolicy,payment:SignedCanary,host:CanaryHostBinding,rpc:CanaryRpc=createCanaryRpc(),reader?:CanaryJsonReader,now:()=>number=Date.now){
    this.#policy=canaryPolicy(policy);validateCanaryBlob(this.#policy,payment);this.#payment=structuredClone(payment);this.#host=canaryHostBinding(host);this.#rpc=rpc;this.#reader=reader;this.#now=now;
  }
  async prepare(policy:CanaryPolicy):Promise<SignedCanary>{
    if(canaryPolicyHash(policy)!==canaryPolicyHash(this.#policy)||this.#now()<policy.notBefore||this.#now()>=policy.expiresAt)throw new Error('Presigned canary policy is inactive');
    const result=object(await this.#rpc({command:'ledger_entry',index:policy.lease,ledger_index:'validated'})),token=object(result.node);
    if(token.LedgerEntryType!=='URIToken'||token.Owner!==policy.canaryAccount||token.Issuer!==policy.hostAccount||await this.hostExpiry()!==policy.baselineExpiry)throw new Error('Presigned canary lease baseline differs');
    return structuredClone(this.#payment);
  }
  async ledgerIndex():Promise<number>{const result=object(await this.#rpc({command:'ledger_current'})),n=result.ledger_current_index;if(!Number.isSafeInteger(n)||Number(n)<1||Number(n)>0xffffffff)throw new Error('Invalid current ledger');return Number(n);}
  async submit(blob:string):Promise<void>{
    if(this.#submitted||blob!==this.#payment.blob||this.#now()<this.#policy.notBefore||this.#now()>=this.#policy.expiresAt)throw new Error('Presigned canary dispatch closed');
    validateCanaryBlob(this.#policy,this.#payment);this.#submitted=true;await this.#rpc({command:'submit',tx_blob:blob});
  }
  async find(hash:string):Promise<{hash:string;validated:boolean;ledger:number;result:string}|null>{
    if(hash!==this.#payment.hash)throw new Error('Presigned lookup hash differs');
    const result=object(await this.#rpc({command:'tx',transaction:hash,binary:false})),tx=object(result.tx_json||result),meta=object(result.meta||{}),ledger=result.ledger_index||tx.ledger_index;
    if((result.hash||tx.hash)!==hash||tx.Account!==this.#policy.canaryAccount||tx.Destination!==this.#policy.hostAccount||tx.TransactionType!=='Payment'||!Number.isSafeInteger(ledger)||Number(ledger)<1||typeof meta.TransactionResult!=='string'||!/^[A-Za-z0-9_]{1,80}$/.test(meta.TransactionResult))return null;
    return{hash,validated:result.validated===true,ledger:Number(ledger),result:meta.TransactionResult};
  }
  async hostExpiry():Promise<number|null>{return observeCanaryHost(this.#policy,this.#host,this.#reader);}
}

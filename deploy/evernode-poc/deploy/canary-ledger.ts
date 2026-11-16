import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {boundedJson} from '../shared/http.ts';
import {canaryHostBinding,observeCanaryHost} from './canary-host.ts';
import type {CanaryHostBinding,CanaryJsonReader} from './canary-host.ts';
export type {CanaryHostBinding} from './canary-host.ts';
import {object} from '../shared/health.ts';
import {canaryPolicy,canaryPolicyHash} from './canary-policy.ts';
import {validateCanaryBlob} from './canary-executor.ts';
import type {CanaryPolicy} from './canary-policy.ts';
import type {CanaryLedger,SignedCanary} from './canary-executor.ts';

export type CanarySession={
  lease:(id:string)=>Promise<unknown>;
  prepare:(policy:CanaryPolicy)=>Promise<unknown>;
  ledgerIndex:()=>Promise<number>;
  submit:(blob:string)=>Promise<unknown>;
  transaction:(hash:string)=>Promise<unknown>;
  close:()=>Promise<void>;
};
type JsonReader=CanaryJsonReader;
async function deadline<T>(work:Promise<T>,ms=5000):Promise<T>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([work,new Promise<T>((_r,reject)=>{timer=setTimeout(()=>reject(new Error('Canary network deadline')),ms);})]);}finally{clearTimeout(timer);}}
function transactionHash(blob:string):string{return createHash('sha512').update(Buffer.from('54584E00','hex')).update(Buffer.from(blob,'hex')).digest('hex').slice(0,64).toUpperCase();}

/** Only the limited canary signer reaches this adapter. Main-wallet credentials
 * and host session cookies are neither accepted nor needed. Dispatch durability
 * and four-controller authorization belong to CanaryExecutor, outside transport. */
export class XahauCanaryLedger implements CanaryLedger{
  #policy:CanaryPolicy;#session:CanarySession;#binding:CanaryHostBinding;#keys:{publicKey:string;privateKey:string};#read:JsonReader;#now:()=>number;#submitted=false;#closed=false;
  constructor(policy:CanaryPolicy,keys:{publicKey:string;privateKey:string},host:CanaryHostBinding,session:CanarySession,reader:JsonReader=boundedJson,now:()=>number=Date.now){
    this.#policy=canaryPolicy(policy);this.#binding=canaryHostBinding(host);this.#session=session;this.#read=reader;this.#now=now;
    const keypairs=createRequire(import.meta.url)('ripple-keypairs');
    if(!/^(02|03)[A-F0-9]{64}$/i.test(keys.publicKey)||!/^00[A-F0-9]{64}$/i.test(keys.privateKey)||keypairs.deriveAddress(keys.publicKey)!==this.#policy.canaryAccount)throw new Error('Limited canary signer differs');
    this.#keys={publicKey:keys.publicKey.toUpperCase(),privateKey:keys.privateKey.toUpperCase()};
  }
  async prepare(raw:CanaryPolicy):Promise<SignedCanary>{
    const p=this.#policy;
    if(this.#closed||canaryPolicyHash(raw)!==canaryPolicyHash(p)||this.#now()<p.notBefore||this.#now()>=p.expiresAt)throw new Error('Canary preparation is outside policy');
    const token=object(await deadline(this.#session.lease(p.lease)));
    if(token.Owner!==p.canaryAccount||token.Issuer!==p.hostAccount||await this.hostExpiry()!==p.baselineExpiry)throw new Error('Canary lease owner or baseline differs');
    const prepared=object(await deadline(this.#session.prepare(p)));
    const require=createRequire(import.meta.url),codec=require('xrpl-binary-codec-prerelease'),keypairs=require('ripple-keypairs');
    // Fee, sequence, expiry and network come from the SDK's unsigned preparation.
    // The independent decoder below accepts only this fixed lease payment.
    const tx={...prepared,SigningPubKey:this.#keys.publicKey};
    const signed={...tx,TxnSignature:keypairs.sign(codec.encodeForSigning(tx),this.#keys.privateKey)};
    const blob=codec.encode(signed).toUpperCase(),payment={blob,hash:transactionHash(blob)};
    validateCanaryBlob(p,payment);return payment;
  }
  async ledgerIndex():Promise<number>{const n=await deadline(this.#session.ledgerIndex());if(!Number.isSafeInteger(n)||n<1||n>0xffffffff)throw new Error('Invalid live ledger index');return n;}
  async submit(blob:string):Promise<void>{
    if(this.#closed||this.#submitted||this.#now()<this.#policy.notBefore||this.#now()>=this.#policy.expiresAt)throw new Error('Canary dispatch is closed');
    validateCanaryBlob(this.#policy,{blob,hash:transactionHash(blob)});
    this.#submitted=true; // A timeout is final for dispatch; callers reconcile hash.
    await deadline(this.#session.submit(blob));
  }
  async find(hash:string):Promise<{hash:string;validated:boolean;ledger:number;result:string}|null>{
    if(!/^[A-F0-9]{64}$/.test(hash))throw new Error('Invalid canary lookup hash');
    const result=object(await deadline(this.#session.transaction(hash))),tx=object(result.tx_json||result);
    const actual=result.hash||tx.hash,meta=object(result.meta||{}),ledger=result.ledger_index||tx.ledger_index;
    if(actual!==hash||tx.TransactionType!=='Payment'||tx.Account!==this.#policy.canaryAccount||tx.Destination!==this.#policy.hostAccount||!Number.isSafeInteger(ledger)||Number(ledger)<1||typeof meta.TransactionResult!=='string'||!/^[A-Za-z0-9_]{1,80}$/.test(meta.TransactionResult))return null;
    return{hash,validated:result.validated===true,ledger:Number(ledger),result:meta.TransactionResult};
  }
  async hostExpiry():Promise<number|null>{return observeCanaryHost(this.#policy,this.#binding,this.#read);}
  async close():Promise<void>{this.#closed=true;this.#keys={publicKey:'',privateKey:''};await deadline(this.#session.close()).catch(()=>{});}
}

/** The locked SDK prepares fees and sequences without a seed. Its submit method
 * sends one raw request; the retrying signAndSubmit/submitAndWait paths are disabled. */
export async function connectCanarySession(raw:CanaryPolicy):Promise<CanarySession>{
  const p=canaryPolicy(raw),{Defaults,TenantClient,XrplApi}=createRequire(import.meta.url)('evernode-js-client');
  await deadline(Defaults.useNetwork('mainnet'));
  const api=new XrplApi('wss://xahau.network',{autoReconnect:false,fallbackRippledServers:[],xrplClientOptions:{connectionTimeout:5000,timeout:5000}}),tenant=new TenantClient(p.canaryAccount,null,{xrplApi:api});
  const deny=()=>{throw new Error('Canary convenience submission disabled');};
  for(const method of ['prepareAccount','acquireLease','acquireLeaseSubmit','extendLease','extendLeaseSubmit','terminateLease'])tenant[method]=deny;
  tenant.xrplAcc.signAndSubmit=deny;const rawSubmit=api.submit.bind(api);for(const method of ['submit','submitAndWait','submitMultisigned'])api[method]=deny;
  let lastLedgerAt=Date.now();api.on('ledger',()=>{lastLedgerAt=Date.now();});
  try{await deadline(tenant.connect());}catch{await api.disconnect().catch(()=>{});throw new Error('Canary read connection unavailable');}
  return Object.freeze({
    lease:(id:string)=>api.getURITokenByIndex(id),
    prepare:(policy:CanaryPolicy)=>{if(canaryPolicyHash(policy)!==canaryPolicyHash(p))throw new Error('Canary session policy differs');return tenant.prepareExtendLeaseTransaction(p.hostAccount,p.rentEVR,p.lease);},
    ledgerIndex:async()=>{if(Date.now()-lastLedgerAt>15000)throw new Error('Ledger stream is stale');return api.ledgerIndex;},
    submit:(blob:string)=>rawSubmit(blob),
    transaction:(hash:string)=>api.getTxnInfo(hash),
    close:async()=>{await tenant.disconnect().catch(()=>{});await api.disconnect().catch(()=>{});}
  });
}

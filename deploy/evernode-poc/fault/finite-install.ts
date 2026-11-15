import {createHash,sign} from 'node:crypto';
import type {KeyObject} from 'node:crypto';
import {mkdir,open,readFile,lstat,rename} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {object} from '../shared/health.ts';
import {ControlError,isControlId,verifyOperator} from './protocol.ts';

export type FiniteRequest<T>={version:1;contractId:string;targetId:'g1'|'g2';generation:string;operationId:string;issuedAt:number;payload:T};
export type FiniteReceipt={version:1;contractId:string;targetId:'g1'|'g2';operationId:string;requestHash:string;payloadHash:string};
type Options<T>={purpose:string;contractId:string;targetId:'g1'|'g2';generation:()=>string;operatorPublicKey:string;directory:string;parse:(raw:unknown)=>T;now?:()=>number};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function request<T>(raw:unknown,parse:(raw:unknown)=>T):FiniteRequest<T>{
  const r=object(raw),fields=['version','contractId','targetId','generation','operationId','issuedAt','payload'];
  if(Object.keys(r).sort().join(',')!==fields.sort().join(',')||r.version!==1||typeof r.contractId!=='string'||!isControlId(r.contractId)||!['g1','g2'].includes(String(r.targetId))||!isControlId(r.generation)||!isControlId(r.operationId)||!Number.isSafeInteger(r.issuedAt)||Number(r.issuedAt)<0)throw new ControlError('invalid-finite-install');
  return{version:1,contractId:r.contractId,targetId:r.targetId as 'g1'|'g2',generation:r.generation,operationId:r.operationId,issuedAt:Number(r.issuedAt),payload:parse(r.payload)};
}
export function finiteBytes<T>(purpose:string,raw:FiniteRequest<T>,parse:(raw:unknown)=>T):Buffer{
  if(!/^[a-z][a-z-]{2,39}$/.test(purpose))throw new ControlError('invalid-finite-purpose');
  const r=request(raw,parse);
  return Buffer.from(JSON.stringify(['warthog-evernode-finite-install-v1',purpose,r.version,r.contractId,r.targetId,r.generation,r.operationId,r.issuedAt,hash(JSON.stringify(r.payload))]));
}
export function signFinite<T>(purpose:string,r:FiniteRequest<T>,parse:(raw:unknown)=>T,key:KeyObject|string):string{return sign(null,finiteBytes(purpose,r,parse),key).toString('base64');}

/** One immutable, root-authorized finite capability. Restarts can restore the
 * original signed envelope, but cannot replace it or disclose its payload. */
export class FiniteInstaller<T>{
  #o:Options<T>;#queue:Promise<unknown>=Promise.resolve();
  constructor(options:Options<T>){if(!isAbsolute(options.directory)||options.directory.split(/[\\/]/).includes('..')||!isControlId(options.contractId)||!['g1','g2'].includes(options.targetId))throw new ControlError('invalid-finite-options');this.#o=options;}
  async #read():Promise<{request:FiniteRequest<T>;signature:string;receipt:FiniteReceipt}|null>{
    const file=this.#o.directory+'/envelope.json';let meta;
    try{meta=await lstat(file);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
    if(!meta.isFile()||meta.size>131072||process.platform!=='win32'&&(meta.mode&0o077)!==0)throw new ControlError('corrupt-finite-install');
    const envelope=object(JSON.parse(await readFile(file,'utf8')));
    if(Object.keys(envelope).sort().join(',')!=='request,signature'||typeof envelope.signature!=='string')throw new ControlError('corrupt-finite-install');
    const r=request(envelope.request,this.#o.parse),bytes=finiteBytes(this.#o.purpose,r,this.#o.parse);
    if(r.contractId!==this.#o.contractId||r.targetId!==this.#o.targetId)throw new ControlError('wrong-target');
    verifyOperator(this.#o.operatorPublicKey,bytes,envelope.signature);
    const receipt:FiniteReceipt={version:1,contractId:r.contractId,targetId:r.targetId,operationId:r.operationId,requestHash:hash(bytes),payloadHash:hash(JSON.stringify(r.payload))};
    return{request:r,signature:envelope.signature,receipt};
  }
  async status():Promise<{installed:false}|{installed:true;receipt:FiniteReceipt}>{const existing=await this.#read();return existing?{installed:true,receipt:existing.receipt}:{installed:false};}
  async payload():Promise<T|null>{const existing=await this.#read();return existing?structuredClone(existing.request.payload):null;}
  async execute(raw:unknown,signature:string):Promise<{installed:true;receipt:FiniteReceipt}>{
    const r=request(raw,this.#o.parse),bytes=finiteBytes(this.#o.purpose,r,this.#o.parse),o=this.#o;
    if(r.contractId!==o.contractId||r.targetId!==o.targetId)throw new ControlError('wrong-target');
    verifyOperator(o.operatorPublicKey,bytes,signature);
    const work=this.#queue.then(async()=>{
      const existing=await this.#read();if(existing){if(existing.receipt.requestHash!==hash(bytes))throw new ControlError('finite-install-conflict');return{installed:true as const,receipt:existing.receipt};}
      const now=(o.now||Date.now)();
      if(r.generation!==o.generation())throw new ControlError('wrong-generation');
      if(r.issuedAt>now+5000||now-r.issuedAt>30000)throw new ControlError('expired-finite-install');
      await mkdir(o.directory,{recursive:true,mode:0o700});
      const dirMeta=await lstat(o.directory);if(!dirMeta.isDirectory()||process.platform!=='win32'&&(dirMeta.mode&0o077)!==0)throw new ControlError('private-finite-directory-required');
      const text=JSON.stringify({request:r,signature}),temporary=o.directory+'/envelope.next';
      let file;try{file=await open(temporary,'wx',0o600);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const m=await lstat(temporary);if(!m.isFile()||m.size>131072||await readFile(temporary,'utf8')!==text)throw new ControlError('finite-install-conflict');}
      if(file)try{await file.writeFile(text);await file.sync();}finally{await file.close();}
      await rename(temporary,o.directory+'/envelope.json');
      if(process.platform!=='win32'){const d=await open(o.directory,'r');try{await d.sync();}finally{await d.close();}const p=await open(dirname(o.directory),'r');try{await p.sync();}finally{await p.close();}}
      return{installed:true as const,receipt:(await this.#read())!.receipt};
    });this.#queue=work.catch(()=>{});return work;
  }
}

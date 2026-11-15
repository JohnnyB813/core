import {createHash,sign} from 'node:crypto';
import type {KeyObject} from 'node:crypto';
import {mkdir,readdir,lstat,readFile,open,rename} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {parseConfig} from '../gateway/config.ts';
import type {GatewayConfig} from '../gateway/config.ts';
import {object} from '../shared/health.ts';
import {ControlError,isControlId,verifyOperator} from './protocol.ts';
export type ConfigUpdate={version:1;contractId:string;targetId:string;generation:string;operationId:string;issuedAt:number;revision:number;previousHash:string;config:GatewayConfig};
type Options={contractId:string;targetId:string;generation:()=>string;operatorPublicKey:string;directory:string;initialFile:string;initialHash:()=>Promise<string>;paused:()=>boolean;now?:()=>number};
export type CurrentConfig={revision:number;configHash:string;operationId:string|null;requestHash:string|null;path:string;config:GatewayConfig};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function parseUpdate(raw:unknown):ConfigUpdate{
 const b=object(raw),fields=['version','contractId','targetId','generation','operationId','issuedAt','revision','previousHash','config'];
 if(Object.keys(b).sort().join(',')!==fields.sort().join(',')||b.version!==1||typeof b.contractId!=='string'||typeof b.targetId!=='string'||!/^(w[1-3]|g[12])$/.test(b.targetId)||!isControlId(b.generation)||!isControlId(b.operationId)||!Number.isSafeInteger(b.issuedAt)||Number(b.issuedAt)<0||!Number.isSafeInteger(b.revision)||Number(b.revision)<1||Number(b.revision)>16||typeof b.previousHash!=='string'||!(/^[a-f0-9]{64}$/).test(b.previousHash))throw new ControlError('invalid-config-update');
 const config=parseConfig(b.config);if(config.contractId!==b.contractId||config.controllerEndpoints.length!==5||config.backends.map(x=>x.id).sort().join(',')!=='w1,w2,w3')throw new ControlError('invalid-config-update');
 return{version:1,contractId:b.contractId,targetId:b.targetId,generation:b.generation,operationId:b.operationId,issuedAt:Number(b.issuedAt),revision:Number(b.revision),previousHash:b.previousHash,config};
}
export function configUpdateBytes(raw:ConfigUpdate):Buffer{const b=parseUpdate(raw);return Buffer.from(JSON.stringify(['warthog-evernode-config-update-v1',b.version,b.contractId,b.targetId,b.generation,b.operationId,b.issuedAt,b.revision,b.previousHash,hash(JSON.stringify(b.config))]));}
export function signConfigUpdate(request:ConfigUpdate,key:KeyObject|string):string{return sign(null,configUpdateBytes(request),key).toString('base64');}
function replacement(before:GatewayConfig,after:GatewayConfig){
 if(JSON.stringify({...before,backends:[]})!==JSON.stringify({...after,backends:[]})||before.backends.map(b=>b.id).join(',')!==after.backends.map(b=>b.id).join(','))throw new ControlError('config-policy-change');
 const changed=after.backends.filter((b,i)=>b.url!==before.backends[i].url);
 if(changed.length!==1||new URL(changed[0].url).protocol!=='https:')throw new ControlError('expected-one-tls-worker-replacement');
}
/** Append-only signed revisions preserve the initial setup receipt and reporter
 * key. A durable claim with no completed revision is never replayed. */
export class ConfigUpdater{
 #options:Options;#queue:Promise<unknown>=Promise.resolve();
 constructor(options:Options){if(!isAbsolute(options.directory)||!isAbsolute(options.initialFile)||[options.directory,options.initialFile].some(p=>p.split(/[\\/]/).includes('..')))throw new ControlError('invalid-config-store');this.#options=options;}
 async #read(path:string,max:number){const s=await lstat(path);if(!s.isFile()||s.size>max)throw new ControlError('corrupt-config-revision');return readFile(path,'utf8');}
 #scope(request:ConfigUpdate){if(request.contractId!==this.#options.contractId||request.targetId!==this.#options.targetId)throw new ControlError('wrong-target');}
 async current():Promise<CurrentConfig>{
  const o=this.#options,config=parseConfig(JSON.parse(await this.#read(o.initialFile,16384))),configHash=hash(JSON.stringify(config));
  if(configHash!==await o.initialHash()||config.contractId!==o.contractId)throw new ControlError('corrupt-initial-configuration');
  let current:CurrentConfig={revision:0,configHash,operationId:null,requestHash:null,path:o.initialFile,config};let names:string[];
  try{names=await readdir(o.directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return current;throw error;}
  if(!(await lstat(o.directory)).isDirectory()||names.some(n=>!/^r\d{4}(?:\.claim)?$/.test(n)&&!/^[a-f0-9-]{36}\.next$/.test(n)))throw new ControlError('corrupt-config-revision');
  const revisions=names.filter(n=>/^r\d{4}$/.test(n)).sort();if(revisions.length>16)throw new ControlError('corrupt-config-revision');
  for(const name of revisions){
   if(name!=='r'+String(current.revision+1).padStart(4,'0'))throw new ControlError('config-revision-gap');
   const directory=o.directory+'/'+name;if(!(await lstat(directory)).isDirectory())throw new ControlError('corrupt-config-revision');
   const record=object(JSON.parse(await this.#read(directory+'/record.json',32768)));if(Object.keys(record).sort().join(',')!=='request,signature'||typeof record.signature!=='string')throw new ControlError('corrupt-config-revision');
   const request=parseUpdate(record.request);this.#scope(request);verifyOperator(o.operatorPublicKey,configUpdateBytes(request),record.signature);
   if(request.revision!==current.revision+1||request.previousHash!==current.configHash)throw new ControlError('config-revision-gap');replacement(current.config,request.config);
   const text=await this.#read(directory+'/config.json',16384);if(text!==JSON.stringify(request.config)+'\n')throw new ControlError('corrupt-config-revision');
   current={revision:request.revision,configHash:hash(JSON.stringify(request.config)),operationId:request.operationId,requestHash:hash(configUpdateBytes(request)),path:directory+'/config.json',config:request.config};
  }
  return current;
 }
 async execute(raw:unknown,signature:string):Promise<CurrentConfig>{
  const request=parseUpdate(raw);this.#scope(request);const bytes=configUpdateBytes(request);verifyOperator(this.#options.operatorPublicKey,bytes,signature);
  const work=this.#queue.then(async()=>{
   const o=this.#options,current=await this.current(),requestHash=hash(bytes);
   if(current.revision===request.revision&&current.requestHash===requestHash)return current;
   if(request.revision!==current.revision+1||request.previousHash!==current.configHash)throw new ControlError('config-revision-conflict');
   const now=(o.now||Date.now)();if(request.generation!==o.generation())throw new ControlError('wrong-generation');if(request.issuedAt>now+5000||now-request.issuedAt>30000)throw new ControlError('expired-config-update');if(o.paused())throw new ControlError('configuration-paused');replacement(current.config,request.config);
   await mkdir(o.directory,{recursive:true,mode:0o700});const name='r'+String(request.revision).padStart(4,'0');let claim;
   try{claim=await open(o.directory+'/'+name+'.claim','wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new ControlError('config-update-uncertain');throw error;}
   try{await claim.writeFile(requestHash+'\n');await claim.sync();}finally{await claim.close();}
   const temporary=o.directory+'/'+request.operationId+'.next';await mkdir(temporary,{mode:0o700});
   for(const [file,contents]of [['record.json',JSON.stringify({request,signature})+'\n'],['config.json',JSON.stringify(request.config)+'\n']]){const handle=await open(temporary+'/'+file,'wx',0o600);try{await handle.writeFile(contents);await handle.sync();}finally{await handle.close();}}
   if(process.platform!=='win32'){const d=await open(temporary,'r');try{await d.sync();}finally{await d.close();}}
   await rename(temporary,o.directory+'/'+name);if(process.platform!=='win32'){const d=await open(o.directory,'r');try{await d.sync();}finally{await d.close();}}
   return this.current();
  });this.#queue=work.catch(()=>{});return work;
 }
}

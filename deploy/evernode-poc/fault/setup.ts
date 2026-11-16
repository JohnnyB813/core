import {createHash,sign} from 'node:crypto';
import type {KeyObject} from 'node:crypto';
import {mkdir,open,readFile,rename,lstat} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {parseConfig} from '../gateway/config.ts';
import type {GatewayConfig} from '../gateway/config.ts';
import {object} from '../shared/health.ts';
import {reporterKeys} from '../reporter/identity.ts';
import {ControlError,isControlId,verifyOperator} from './protocol.ts';
export type SetupRequest={version:1;contractId:string;targetId:string;generation:string;operationId:string;issuedAt:number;reporterKey:string;config:unknown};
export type SetupReceipt={version:1;contractId:string;targetId:string;operationId:string;requestHash:string;configHash:string;reporterPublicKey:string};
type SetupOptions={contractId:string;targetId:string;generation:()=>string;operatorPublicKey:string;reporterPublicKey:string;directory:string;now?:()=>number};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function parseSetup(value:unknown):SetupRequest{
  const body=object(value),allowed=['version','contractId','targetId','generation','operationId','issuedAt','reporterKey','config'];
  if(Object.keys(body).length!==allowed.length||Object.keys(body).some(key=>!allowed.includes(key))||body.version!==1||typeof body.contractId!=='string'||typeof body.targetId!=='string'||!/^(?:w[1-3]|g[12])$/.test(body.targetId)||!isControlId(body.generation)||!isControlId(body.operationId)||!Number.isSafeInteger(body.issuedAt)||typeof body.reporterKey!=='string'||!/^ed[0-9a-f]{128}$/i.test(body.reporterKey))throw new ControlError('invalid-setup');
  return body as SetupRequest;
}
function fixedConfig(value:unknown,contractId:string):GatewayConfig{
  const config=parseConfig(value);
  if(config.contractId!==contractId||config.controllerEndpoints.length!==5||config.backends.length!==3||config.backends.map(b=>b.id).sort().join(',')!=='w1,w2,w3')throw new ControlError('invalid-setup-configuration');
  return config;
}
export function setupBytes(request:SetupRequest):Buffer{
  const parsed=parseSetup(request),configuration=fixedConfig(parsed.config,parsed.contractId);
  return Buffer.from(JSON.stringify(['warthog-evernode-pilot-setup-v1',parsed.version,parsed.contractId,parsed.targetId,parsed.generation,parsed.operationId,parsed.issuedAt,hash(parsed.reporterKey),hash(JSON.stringify(configuration))]));
}
export function signSetup(request:SetupRequest,key:KeyObject|string):string{return sign(null,setupBytes(request),key).toString('base64');}
export class SetupInstaller {
  #options:SetupOptions;#queue:Promise<unknown>=Promise.resolve();
  constructor(options:SetupOptions){if(!/^ed[0-9a-f]{64}$/.test(options.reporterPublicKey)||!isAbsolute(options.directory)||options.directory.split(/[\\/]/).includes('..'))throw new ControlError('invalid-setup-options');this.#options=options;}
  async #read(file:string,maximum:number):Promise<string>{const meta=await lstat(file);if(!meta.isFile()||meta.size>maximum)throw new ControlError('corrupt-setup');return readFile(file,'utf8');}
  async status():Promise<{installed:false}|{installed:true;receipt:SetupReceipt}>{
    let text:string;try{text=await this.#read(this.#options.directory+'/receipt.json',4096);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{installed:false};throw new ControlError('setup-unavailable');}
    if(Buffer.byteLength(text)>4096)throw new ControlError('corrupt-setup');
    const receipt=JSON.parse(text) as SetupReceipt;
    const fields=['version','contractId','targetId','operationId','requestHash','configHash','reporterPublicKey'];
    if(Object.keys(receipt).length!==fields.length||Object.keys(receipt).some(field=>!fields.includes(field))||receipt.version!==1||receipt.contractId!==this.#options.contractId||receipt.targetId!==this.#options.targetId||receipt.reporterPublicKey!==this.#options.reporterPublicKey||!/^[a-f0-9]{64}$/.test(receipt.requestHash)||!/^[a-f0-9]{64}$/.test(receipt.configHash)||!isControlId(receipt.operationId))throw new ControlError('corrupt-setup');
    const config=fixedConfig(JSON.parse(await this.#read(this.#options.directory+'/config.json',16384)),this.#options.contractId);
    if(hash(JSON.stringify(config))!==receipt.configHash)throw new ControlError('corrupt-setup');
    await reporterKeys((await this.#read(this.#options.directory+'/reporter.key',256)).trim(),this.#options.reporterPublicKey);
    return{installed:true,receipt};
  }
  async execute(value:unknown,signature:string):Promise<{installed:true;receipt:SetupReceipt}>{
    const request=parseSetup(value),options=this.#options;
    if(request.contractId!==options.contractId||request.targetId!==options.targetId)throw new ControlError('wrong-target');
    const bytes=setupBytes(request);verifyOperator(options.operatorPublicKey,bytes,signature);
    const operation=this.#queue.then(async()=>{
      const requestHash=hash(bytes),existing=await this.status();
      if(existing.installed){if(existing.receipt.requestHash!==requestHash)throw new ControlError('setup-conflict');return existing;}
      const now=(options.now||Date.now)();
      if(request.generation!==options.generation())throw new ControlError('wrong-generation');
      if(request.issuedAt>now+5000||now-request.issuedAt>30000)throw new ControlError('expired-setup');
      const config=fixedConfig(request.config,options.contractId);
      await reporterKeys(request.reporterKey,options.reporterPublicKey);
      const receipt:SetupReceipt={version:1,contractId:options.contractId,targetId:options.targetId,operationId:request.operationId,requestHash,configHash:hash(JSON.stringify(config)),reporterPublicKey:options.reporterPublicKey};
      const temporary=options.directory+'.'+request.operationId+'.next';
      await mkdir(dirname(options.directory),{recursive:true,mode:0o700});
      try{await mkdir(temporary,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const meta=await lstat(temporary);if(!meta.isDirectory())throw new ControlError('setup-conflict');}
      for(const [name,contents]of [['config.json',JSON.stringify(config)+'\n'],['reporter.key',request.reporterKey+'\n'],['receipt.json',JSON.stringify(receipt)+'\n']]){
        let file;try{file=await open(temporary+'/'+name,'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(await this.#read(temporary+'/'+name,16384)!==contents)throw new ControlError('setup-conflict');continue;}
        try{await file.writeFile(contents);await file.sync();}finally{await file.close();}
      }
      if(process.platform!=='win32'){const directory=await open(temporary,'r');try{await directory.sync();}finally{await directory.close();}}
      await rename(temporary,options.directory);
      if(process.platform!=='win32'){const directory=await open(dirname(options.directory),'r');try{await directory.sync();}finally{await directory.close();}}
      return{installed:true as const,receipt};
    });
    this.#queue=operation.catch(()=>{});return operation;
  }
}

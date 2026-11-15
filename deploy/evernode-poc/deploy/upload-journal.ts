import {mkdir,open,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {validateUploadPlan} from './bootstrap-client.ts';
import type {UploadJournal,UploadPlan,UploadReceipt} from './bootstrap-client.ts';
export class FileUploadJournal implements UploadJournal{
  #directory:string;
  constructor(directory:string){this.#directory=directory;}
  #path(id:string,suffix:string){if(!/^[a-z0-9-]{12,80}$/.test(id))throw new Error('Invalid upload operation ID');return join(this.#directory,id+suffix);}
  async #syncDirectory(){if(process.platform==='win32')return;const stream=await open(this.#directory,'r');try{await stream.sync();}finally{await stream.close();}}
  async create(value:UploadPlan){const plan=validateUploadPlan(value);await mkdir(this.#directory,{recursive:true,mode:0o700});const stream=await open(this.#path(plan.operationId,'.plan.json'),'wx',0o600);try{await stream.writeFile(JSON.stringify(plan)+'\n');await stream.sync();}finally{await stream.close();}await this.#syncDirectory();}
  async get(id:string):Promise<UploadPlan>{const text=await readFile(this.#path(id,'.plan.json'),'utf8');if(Buffer.byteLength(text)>16384)throw new Error('Invalid upload plan size');const plan=validateUploadPlan(JSON.parse(text));if(plan.operationId!==id)throw new Error('Upload operation differs');return plan;}
  async claim(id:string):Promise<boolean>{await this.get(id);let stream;try{stream=await open(this.#path(id,'.claimed'),'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}try{await stream.writeFile(id+'\n');await stream.sync();}finally{await stream.close();}await this.#syncDirectory();return true;}
  async record(receipt:UploadReceipt){if(!['applied','uncertain'].includes(receipt.state)||!Number.isSafeInteger(receipt.at)||receipt.ledger!==undefined&&!Number.isSafeInteger(receipt.ledger))throw new Error('Invalid upload receipt');const stream=await open(this.#path(receipt.operationId,'.receipts.jsonl'),'a',0o600);try{await stream.writeFile(JSON.stringify(receipt)+'\n');await stream.sync();}finally{await stream.close();}await this.#syncDirectory();}
  async latest(id:string):Promise<UploadReceipt|null>{let text;try{text=await readFile(this.#path(id,'.receipts.jsonl'),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}if(text.length>1048576||!text.endsWith('\n'))throw new Error('Upload receipt log is corrupt');const rows=text.trim().split('\n').map(line=>JSON.parse(line));if(rows.some(row=>row.operationId!==id||!['uncertain','applied'].includes(row.state)||Object.keys(row).some(k=>!['operationId','state','at','ledger'].includes(k))||!Number.isSafeInteger(row.at)||row.ledger!==undefined&&!Number.isSafeInteger(row.ledger)))throw new Error('Upload receipt log is invalid');return rows.at(-1)||null;}
}

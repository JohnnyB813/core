import {mkdir,open,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {RestartJournal,RestartPlan,RestartReceipt} from './evrpanel.ts';

/** Append-only receipts and a permanent exclusive claim prevent mutation replay. */
export class FileRestartJournal implements RestartJournal {
  #directory:string;
  constructor(directory:string){this.#directory=directory;}
  #path(id:string,suffix:string){if(!/^[a-z0-9-]{12,80}$/.test(id))throw new Error('Invalid operation ID');return join(this.#directory,id+suffix);}
  async #directorySync(){if(process.platform==='win32')return;const directory=await open(this.#directory,'r');try{await directory.sync();}finally{await directory.close();}}
  async create(plan:RestartPlan){
    const target=this.#path(plan.operationId,'.plan.json');await mkdir(this.#directory,{recursive:true,mode:0o700});
    const file=await open(target,'wx',0o600);try{await file.writeFile(JSON.stringify(plan)+'\n');await file.sync();}finally{await file.close();}await this.#directorySync();
  }
  async get(id:string):Promise<RestartPlan>{
    const text=await readFile(this.#path(id,'.plan.json'),'utf8');if(Buffer.byteLength(text)>16384)throw new Error('Invalid operation plan');
    const plan=JSON.parse(text);if(plan.operationId!==id)throw new Error('Operation plan identity differs');return plan;
  }
  async claim(id:string):Promise<boolean>{
    await this.get(id);let file;
    try{file=await open(this.#path(id,'.claimed'),'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}
    try{await file.writeFile(id+'\n');await file.sync();}finally{await file.close();}await this.#directorySync();return true;
  }
  async record(receipt:RestartReceipt){
    const file=await open(this.#path(receipt.operationId,'.receipts.jsonl'),'a',0o600);
    try{await file.writeFile(JSON.stringify(receipt)+'\n');await file.sync();}finally{await file.close();}await this.#directorySync();
  }
  async latest(id:string):Promise<RestartReceipt|null>{
    let text:string;try{text=await readFile(this.#path(id,'.receipts.jsonl'),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    if(Buffer.byteLength(text)>1048576||!text.endsWith('\n'))throw new Error('Operation receipt log is corrupt');
    const rows=text.trim().split('\n').map(line=>JSON.parse(line));if(rows.some(row=>row.operationId!==id))throw new Error('Operation receipt identity differs');
    return rows.at(-1)||null;
  }
}

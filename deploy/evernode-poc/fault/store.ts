import {readFile,mkdir,open,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ControlStore,ControlState} from './controller.ts';
export class FileControlStore implements ControlStore {
  #file:string;
  constructor(file:string){this.#file=file;}
  async load():Promise<ControlState|null>{
    let text:string;try{text=await readFile(this.#file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw new Error('Control state cannot be read');}
    if(Buffer.byteLength(text)>262144)throw new Error('Control state exceeds byte cap');
    try{return JSON.parse(text) as ControlState;}catch{throw new Error('Control state is corrupt');}
  }
  async save(state:ControlState):Promise<void>{
    const text=JSON.stringify(state)+'\n';if(Buffer.byteLength(text)>262144)throw new Error('Control state exceeds byte cap');
    await mkdir(dirname(this.#file),{recursive:true,mode:0o700});
    const temporary=this.#file+'.'+randomUUID()+'.next';let file;
    try{file=await open(temporary,'wx',0o600);await file.writeFile(text);await file.sync();await file.close();file=undefined;await rename(temporary,this.#file);
      if(process.platform!=='win32'){const directory=await open(dirname(this.#file),'r');try{await directory.sync();}finally{await directory.close();}}
    }finally{await file?.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
  }
}

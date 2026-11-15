import {mkdir,lstat,open,readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {canaryPolicy,canaryPolicyHash} from './canary-policy.ts';
import type {CanaryPolicy} from './canary-policy.ts';
import {validateCanaryBlob} from './canary-executor.ts';
import type {CanaryJournal,CanaryReceipt,SignedCanary} from './canary-executor.ts';
export class FileCanaryJournal implements CanaryJournal{
 #directory:string;#policy:CanaryPolicy;#claimId:string;
 private constructor(directory:string,policy:CanaryPolicy,claimId:string){this.#directory=directory;this.#policy=policy;this.#claimId=claimId;}
 static async open(directory:string,policy:CanaryPolicy,claimId:string):Promise<FileCanaryJournal>{
  if(!isAbsolute(directory)||directory.split(/[\\/]/).includes('..')||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(claimId))throw new Error('Invalid canary journal identity');
  const journal=new FileCanaryJournal(directory,canaryPolicy(policy),claimId);
  await mkdir(directory,{recursive:true,mode:0o700});const meta=await lstat(directory);
  if(!meta.isDirectory()||process.platform!=='win32'&&(meta.mode&0o077)!==0)throw new Error('Private canary journal directory required');
  const identity=JSON.stringify(journal.#identity());
  if(!await journal.#exclusive('identity.json',identity)&&await journal.#read('identity.json',4096)!==identity)throw new Error('Canary journal scope differs');
  return journal;
 }
 #identity(){return{version:1,operationId:this.#policy.operationId,policyHash:canaryPolicyHash(this.#policy),claimId:this.#claimId};}
 async #syncDirectory(){if(process.platform!=='win32'){const d=await open(this.#directory,'r');try{await d.sync();}finally{await d.close();}}}
 async #exclusive(file:string,contents:string):Promise<boolean>{
  let handle;try{handle=await open(this.#directory+'/'+file,'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}
  try{await handle.writeFile(contents);await handle.sync();}finally{await handle.close();}await this.#syncDirectory();return true;
 }
 async #read(file:string,limit:number):Promise<string>{
  const path=this.#directory+'/'+file,meta=await lstat(path);
  if(!meta.isFile()||meta.size>limit||process.platform!=='win32'&&(meta.mode&0o077)!==0)throw new Error('Corrupt private canary journal');
  return readFile(path,'utf8');
 }
 async readSigned():Promise<SignedCanary|null>{
  let text;try{text=await this.#read('payment.json',32768);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  const payment=JSON.parse(text);validateCanaryBlob(this.#policy,payment);return payment;
 }
 async claimPreparation():Promise<boolean>{return this.#exclusive('preparation.claim',JSON.stringify(this.#identity()));}
 async saveSigned(payment:SignedCanary):Promise<void>{
  validateCanaryBlob(this.#policy,payment);
  if(await this.#read('preparation.claim',4096)!==JSON.stringify(this.#identity()))throw new Error('Canary preparation has not been claimed');
  if(!await this.#exclusive('payment.json',JSON.stringify(payment)))throw new Error('A canary payment is already saved');
 }
 async wasDispatched():Promise<boolean>{
  let text;try{text=await this.#read('dispatch.claim',4096);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  const payment=await this.readSigned();if(!payment||text!==JSON.stringify({...this.#identity(),hash:payment.hash}))throw new Error('Corrupt permanent canary dispatch claim');return true;
 }
 async claimDispatch():Promise<boolean>{
  const payment=await this.readSigned();if(!payment)throw new Error('No saved canary payment');
  return this.#exclusive('dispatch.claim',JSON.stringify({...this.#identity(),hash:payment.hash}));
 }
 async record(receipt:CanaryReceipt):Promise<void>{
  const payment=await this.readSigned();
  if(!payment||receipt.hash!==payment.hash||!['uncertain','validated','host-confirmed','failed'].includes(receipt.state)||!Number.isSafeInteger(receipt.at)||receipt.at<0||Object.keys(receipt).some(k=>!['state','at','hash','ledger','result','expiryTimestamp'].includes(k)))throw new Error('Invalid public canary receipt');
  if(receipt.ledger!==undefined&&(!Number.isSafeInteger(receipt.ledger)||receipt.ledger<1)||receipt.result!==undefined&&(!/^[a-zA-Z0-9_]{1,64}$/.test(receipt.result))||receipt.expiryTimestamp!==undefined&&(!Number.isSafeInteger(receipt.expiryTimestamp)||receipt.expiryTimestamp!==this.#policy.baselineExpiry+3600))throw new Error('Invalid public canary result');
  const file=await open(this.#directory+'/receipts.jsonl','a',0o600);try{await file.writeFile(JSON.stringify(receipt)+'\n');await file.sync();}finally{await file.close();}
 }
}

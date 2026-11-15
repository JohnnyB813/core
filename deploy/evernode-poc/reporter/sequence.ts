import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
// The caller must put this file on the instance's retained application volume.
// A second process or corrupt state fails closed instead of reusing a sequence.
export async function reserveSequence(path:string,now:number):Promise<number>{
  if(!Number.isSafeInteger(now)||now<0)throw new Error('Invalid sequence clock');
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const lock=await open(path+'.lock','wx',0o600);
  let temporaryCreated=false;
  try{
    let previous=-1;
    try{const data=JSON.parse(await readFile(path,'utf8'));if(data.version!==1||!Number.isSafeInteger(data.last)||data.last<0)throw new Error('Corrupt report sequence');previous=data.last;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const sequence=Math.max(previous+1,now);
    if(!Number.isSafeInteger(sequence))throw new Error('Report sequence exhausted');
    const temporary=await open(path+'.next','wx',0o600);temporaryCreated=true;
    try{await temporary.writeFile(JSON.stringify({version:1,last:sequence})+'\n');await temporary.sync();}finally{await temporary.close();}
    await rename(path+'.next',path);temporaryCreated=false;
    return sequence;
  }finally{if(temporaryCreated)await unlink(path+'.next').catch(()=>{});await lock.close();await unlink(path+'.lock');}
}

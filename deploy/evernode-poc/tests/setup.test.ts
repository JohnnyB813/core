import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,realpath,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {SetupInstaller,signSetup} from '../fault/setup.ts';
import type {SetupRequest} from '../fault/setup.ts';
import {loadHotPocket} from '../shared/hotpocket.ts';

async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'poc-setup-')),keys=generateKeyPairSync('ed25519'),reporter=await loadHotPocket().generateKeys();
  const publicKey=Buffer.from(reporter.publicKey).toString('hex'),secret=Buffer.from(reporter.privateKey).toString('hex'),generation=randomUUID();
  const configuration={contractId:'pilot',controllers:['c1','c2','c3','c4','c5'],controllerEndpoints:[1,2,3,4,5].map(i=>({id:'c'+i,url:'wss://c'+i+'.example/',serverKey:'ed'+String(i).repeat(64)})),backends:[1,2,3].map(i=>({id:'w'+i,url:'http://w'+i+'.example'})),reference:'https://reference.example',policy:{checkpoint:{height:5000000,hash:'a'.repeat(64)},minimumHeight:5000000,maxLag:3,minPeers:2,maxLatencyMs:3000,freshnessMs:30000}};
  const options={contractId:'pilot',targetId:'w1',generation:()=>generation,operatorPublicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),reporterPublicKey:publicKey,directory:directory+'/installed',now:()=>100000};
  const request:SetupRequest={version:1,contractId:'pilot',targetId:'w1',generation,operationId:randomUUID(),issuedAt:100000,reporterKey:secret,config:configuration};
  return{directory,keys,publicKey,secret,configuration,options,request,installer:new SetupInstaller(options)};
}
async function cleanup(directory:string){const actual=await realpath(directory),parent=await realpath(tmpdir());if(dirname(actual)!==parent||!basename(actual).startsWith('poc-setup-'))throw new Error('Temporary cleanup target differs');await rm(actual,{recursive:true,force:true});}
test('signed setup installs only the fixed reporter identity and returns no private key',async()=>{
  const f=await fixture();try{
    const result=await f.installer.execute(f.request,signSetup(f.request,f.keys.privateKey));assert.equal(result.installed,true);assert.equal(result.receipt.reporterPublicKey,f.publicKey);
    assert.doesNotMatch(JSON.stringify(result),new RegExp(f.secret));assert.equal((await readFile(f.options.directory+'/reporter.key','utf8')).trim(),f.secret);
    assert.equal((await f.installer.status()).installed,true);
  }finally{await cleanup(f.directory);}
});
test('another signer, another role and another reporter key cannot install',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.installer.execute(f.request,signSetup(f.request,generateKeyPairSync('ed25519').privateKey)),/unauthorized/);
    const role={...f.request,targetId:'w2'};await assert.rejects(f.installer.execute(role,signSetup(role,f.keys.privateKey)),/wrong-target/);
    const other=await loadHotPocket().generateKeys(),key={...f.request,reporterKey:Buffer.from(other.privateKey).toString('hex')};await assert.rejects(f.installer.execute(key,signSetup(key,f.keys.privateKey)),/Reporter identity/);
    assert.equal((await f.installer.status()).installed,false);
  }finally{await cleanup(f.directory);}
});
test('concurrent duplicates and recovery return the same installation without replacing secrets',async()=>{
  const f=await fixture();try{
    const signature=signSetup(f.request,f.keys.privateKey),settled=await Promise.allSettled([f.installer.execute(f.request,signature),f.installer.execute(f.request,signature)]);
    for(const result of settled)if(result.status==='rejected')throw result.reason;
    const results=settled.map(result=>(result as PromiseFulfilledResult<Awaited<ReturnType<SetupInstaller['execute']>>>).value);
    assert.equal(results[0].receipt.requestHash,results[1].receipt.requestHash);
    const recovered=new SetupInstaller({...f.options,generation:()=>randomUUID(),now:()=>200000});assert.equal((await recovered.execute(f.request,signature)).receipt.requestHash,results[0].receipt.requestHash);
    const changed={...f.request,operationId:randomUUID()};await assert.rejects(f.installer.execute(changed,signSetup(changed,f.keys.privateKey)),/setup-conflict/);
  }finally{await cleanup(f.directory);}
});
test('an interrupted staging directory resumes only matching files',async()=>{
  const f=await fixture();try{
    const staging=f.options.directory+'.'+f.request.operationId+'.next';await mkdir(staging);await writeFile(staging+'/reporter.key',f.secret+'\n',{mode:0o600});
    assert.equal((await f.installer.execute(f.request,signSetup(f.request,f.keys.privateKey))).installed,true);
  }finally{await cleanup(f.directory);}
});
test('corrupted installed data fails closed and private extra receipt fields cannot be disclosed',async()=>{
  const f=await fixture();try{
    const result=await f.installer.execute(f.request,signSetup(f.request,f.keys.privateKey));
    await writeFile(f.options.directory+'/receipt.json',JSON.stringify({...result.receipt,privateKey:'must-not-be-returned'}));
    await assert.rejects(f.installer.status(),/corrupt-setup/);
    await writeFile(f.options.directory+'/receipt.json',JSON.stringify(result.receipt));await writeFile(f.options.directory+'/reporter.key','corrupt');await assert.rejects(f.installer.status());
  }finally{await cleanup(f.directory);}
});

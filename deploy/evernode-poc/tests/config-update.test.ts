import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfigUpdater,signConfigUpdate} from '../fault/config-update.ts';
import type {ConfigUpdate} from '../fault/config-update.ts';
import {parseConfig} from '../gateway/config.ts';
const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),contractId='11111111-2222-4333-8444-555555555555',generation=randomUUID(),now=100000;
const base=parseConfig({contractId,controllers:['c1','c2','c3','c4','c5'],controllerEndpoints:Array.from({length:5},(_,i)=>({id:'c'+(i+1),url:'wss://c'+(i+1)+'.example:32001/',serverKey:'ed'+String(i+1).repeat(64)})),backends:['w1','w2','w3'].map(id=>({id,url:'https://'+id+'.example:33001'})),reference:'https://reference.example',policy:{checkpoint:{height:10,hash:'a'.repeat(64)},minimumHeight:10,maxLag:3,minPeers:2,maxLatencyMs:3000,freshnessMs:30000}});
const initialHash=createHash('sha256').update(JSON.stringify(base)).digest('hex');
function update(overrides:Partial<ConfigUpdate>={}):ConfigUpdate{return{version:1,contractId,targetId:'g1',generation,operationId:randomUUID(),issuedAt:now,revision:1,previousHash:initialHash,config:parseConfig({...base,backends:base.backends.map(b=>b.id==='w1'?{...b,url:'https://replacement.example:33001'}:b)}),...overrides};}
async function fixture(work:(f:{directory:string;updater:ConfigUpdater;options:ConstructorParameters<typeof ConfigUpdater>[0]})=>Promise<void>){
 const parent=await realpath(tmpdir()),directory=await mkdtemp(join(parent,'warthog-config-'));
 try{await mkdir(join(directory,'setup'),{mode:0o700});await writeFile(join(directory,'setup/config.json'),JSON.stringify(base)+'\n',{mode:0o600});await writeFile(join(directory,'setup/reporter.key'),'test-only-preserved-secret',{mode:0o600});const options={contractId,targetId:'g1',generation:()=>generation,operatorPublicKey:publicKey,directory:join(directory,'updates'),initialFile:join(directory,'setup/config.json'),initialHash:async()=>initialHash,paused:()=>false,now:()=>now};await work({directory,updater:new ConfigUpdater(options),options});}
 finally{const resolved=await realpath(directory);assert.equal(dirname(resolved),parent);assert(basename(resolved).startsWith('warthog-config-'));await rm(resolved,{recursive:true});}
}
test('a signed one-worker configuration revision preserves the initial setup and reporter key across restart',async()=>fixture(async({directory,updater,options})=>{
 const request=update(),signature=signConfigUpdate(request,keys.privateKey),changed=await updater.execute(request,signature);assert.equal(changed.revision,1);assert.equal(changed.config.backends[0].url,'https://replacement.example:33001');assert.equal(await readFile(join(directory,'setup/reporter.key'),'utf8'),'test-only-preserved-secret');assert.equal(await readFile(options.initialFile,'utf8'),JSON.stringify(base)+'\n');
 assert.deepEqual(await updater.execute(request,signature),changed);assert.deepEqual(await new ConfigUpdater({...options,generation:()=>randomUUID()}).current(),changed);
}));
test('unauthorized, expired, wrong-generation, skipped and policy-changing revisions fail before a write',async()=>fixture(async({updater})=>{
 const wrong=generateKeyPairSync('ed25519');await assert.rejects(updater.execute(update(),signConfigUpdate(update(),wrong.privateKey)));
 const bad=[update({generation:randomUUID()}),update({issuedAt:now-30001}),update({revision:2}),update({targetId:'w2'}),update({config:{...update().config,policy:{...base.policy,maxLag:4}}}),update({config:{...update().config,backends:update().config.backends.map(b=>b.id==='w2'?{...b,url:'https://second.example:33001'}:b)}})];
 for(const request of bad)await assert.rejects(updater.execute(request,signConfigUpdate(request,keys.privateKey)));
 assert.equal((await updater.current()).revision,0);
}));
test('a missing completed revision after a durable claim is not replayed',async()=>fixture(async({directory,updater})=>{
 await mkdir(join(directory,'updates'),{mode:0o700});await writeFile(join(directory,'updates/r0001.claim'),'uncertain',{mode:0o600});const request=update();await assert.rejects(updater.execute(request,signConfigUpdate(request,keys.privateKey)),/config-update-uncertain/);assert.equal((await updater.current()).revision,0);
}));
test('corrupt installed revision bytes and mutation during a pause fail closed',async()=>fixture(async({directory,updater,options})=>{
 const request=update(),signature=signConfigUpdate(request,keys.privateKey);await assert.rejects(new ConfigUpdater({...options,paused:()=>true}).execute(request,signature),/configuration-paused/);await updater.execute(request,signature);await writeFile(join(directory,'updates/r0001/config.json'),'corrupt');await assert.rejects(updater.current());
}));

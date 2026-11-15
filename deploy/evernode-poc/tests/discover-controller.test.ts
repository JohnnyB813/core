import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,verify,createPublicKey} from 'node:crypto';
import {discoverController} from '../deploy/discover-controller.ts';
const contractId='11111111-2222-4333-8444-555555555555',url='wss://controller.example:32001/';
function transport(mode:'ok'|'wrong-contract'|'bad-signature'|'redirect'='ok'){
 let sent=0,terminated=0;const keys=generateKeyPairSync('ed25519'),serverPublic='ed'+keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
 const create=(actualUrl:string,options:Record<string,unknown>)=>{
  assert.equal(actualUrl,url);assert.equal(options.rejectUnauthorized,true);assert.equal(options.followRedirects,false);assert.equal(options.maxPayload,65536);
  const events=new Map<string,((...args:unknown[])=>void)[]>(),emit=(event:string,...args:unknown[])=>events.get(event)?.forEach(f=>f(...args));
  queueMicrotask(()=>mode==='redirect'?emit('unexpected-response'):emit('message',Buffer.from(JSON.stringify({type:'user_challenge',contract_id:mode==='wrong-contract'?'other':contractId,hp_version:'0.6.4',contract_version:'1.0',challenge:'ab'.repeat(32)}))));
  return{on:(event:string,fn:(...args:unknown[])=>void)=>{events.set(event,[...(events.get(event)||[]),fn]);},terminate:()=>{terminated++;},send:(text:string)=>{
   sent++;const response=JSON.parse(text);assert.deepEqual(Object.keys(response).sort(),['protocol','pubkey','server_challenge','sig','type']);assert.equal(response.type,'user_challenge_response');assert.equal(response.protocol,'json');assert.equal(response.server_challenge.length,32);
   const clientKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(response.pubkey.slice(2),'hex')]),format:'der',type:'spki'});assert(verify(null,Buffer.from('ab'.repeat(32)),clientKey,Buffer.from(response.sig,'hex')));
   const signature=sign(null,Buffer.from(response.server_challenge+contractId+'1.0'),keys.privateKey).toString('hex');queueMicrotask(()=>emit('message',Buffer.from(JSON.stringify({type:'server_challenge_response',pubkey:serverPublic,sig:mode==='bad-signature'?'00'.repeat(64):signature}))));
  }};
 };
 return{create,serverPublic,counts:()=>({sent,terminated})};
}
test('initial controller discovery binds a CA-verified WSS origin, contract and Ed25519 proof without an owner key',async()=>{
 const t=transport();assert.deepEqual(await discoverController(url,contractId,t.create,100),{publicKey:t.serverPublic,contractId,contractVersion:'1.0',hpVersion:'0.6.4',source:'strict-wss-ed25519-challenge'});assert.deepEqual(t.counts(),{sent:1,terminated:1});
});
test('wrong contracts, invalid signatures, redirects and insecure origins produce no pin',async()=>{
 for(const mode of ['wrong-contract','bad-signature','redirect']as const){const t=transport(mode);await assert.rejects(discoverController(url,contractId,t.create,100));assert.equal(t.counts().terminated,1);if(mode!=='bad-signature')assert.equal(t.counts().sent,0);}
 await assert.rejects(discoverController('ws://controller.example:32001/',contractId));
});

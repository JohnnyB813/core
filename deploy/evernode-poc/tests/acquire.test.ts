import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireRequirement} from '../shared/acquire.ts';
const key='ed'+'a'.repeat(64),id='11111111-2222-4333-8444-555555555555';
test('acquisition matches Sashimono native create schema exactly',()=>{
 const value=JSON.parse(JSON.stringify(acquireRequirement(key,id,'example/worker:v1--contract--false')));
 assert.deepEqual(Object.keys(value).sort(),['config','contract_id','image','owner_pubkey']);
 assert.equal(value.owner_pubkey,key);assert.equal(value.ownerpubkey,undefined);
 assert.deepEqual(value.config,{});assert.equal(typeof value.contract_id,'string');
});
test('acquisition rejects invalid identities and overlong or injectable payloads',()=>{
 for(const owner of ['ed'+'a'.repeat(128),'a'.repeat(64),''])assert.throws(()=>acquireRequirement(owner,id,'image:v1'));
 for(const image of ['x'.repeat(129),'repo:tag;echo','repo:tag\nnext','repo:tag$secret',''])assert.throws(()=>acquireRequirement(key,id,image));
 assert.throws(()=>acquireRequirement(key,'wrong','image:v1'));
 assert.throws(()=>acquireRequirement(key,id,'image:v1',[] as unknown as Record<string,unknown>));
});
test('acquisition config is a defensive copy and respects the byte cap',()=>{
 const cfg={mesh:{known_peers:['host.example:1234']}};const req=acquireRequirement(key,id,'image:v1',cfg);cfg.mesh.known_peers.push('other:1');assert.deepEqual(req.config,{mesh:{known_peers:['host.example:1234']}});
 assert.throws(()=>acquireRequirement(key,id,'image:v1',{x:'a'.repeat(16385)}));
});

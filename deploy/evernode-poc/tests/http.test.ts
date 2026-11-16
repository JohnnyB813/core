import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedJson,allowedReadPath,endpoint} from '../shared/http.ts';
import {fixture} from './helpers.ts';
test('only exact bounded read paths pass',()=>{
  for(const p of ['/chain/head','/chain/block/1/hash','/chain/block/4294967295/header'])assert.equal(allowedReadPath(p),true);
  for(const p of ['/settings/mempool/minfee/0','/tools/wallet/new','/chain/append','/chain/head?x=1','/chain/head/','/chain/block/0/hash','/chain/block/4294967296/hash','/chain/block/01/hash','/chain/block/1%2fhash','/chain/block/-1/hash'])assert.equal(allowedReadPath(p),false);
});
test('origins exclude credentials, paths, whitespace, and unsupported schemes',()=>{
  assert.equal(endpoint('https://node.example:443').origin,'https://node.example');
  for(const value of ['file:///tmp/a','https://user:secret@host','http://host/path','http://host?x=1','http://host/#key','http://ho\nst'])assert.throws(()=>endpoint(value));
});
test('byte cap applies to the body',async t=>{const f=await fixture((_q,r)=>r.end(JSON.stringify({value:'x'.repeat(4096)})));t.after(f.close);await assert.rejects(boundedJson(f.url,1000,100),/byte limit/);});
test('redirects are not followed',async t=>{let calls=0,sourceCalls=0;const destination=await fixture((_q,r)=>{calls++;r.end('{}');});t.after(destination.close);const f=await fixture((_q,r)=>{sourceCalls++;r.writeHead(302,{location:destination.url});r.end();});t.after(f.close);await assert.rejects(boundedJson(f.url,1000));assert.equal(sourceCalls,1);assert.equal(calls,0);});
test('slow response bodies are inside the timeout',async t=>{const f=await fixture((_q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.write('{');});t.after(f.close);await assert.rejects(boundedJson(f.url,100),(error:unknown)=>error instanceof Error&&error.name==='TimeoutError');});

import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateRawSync} from 'node:zlib';
import {controllerBundle,controllerMembers,initialControllerConfig} from '../deploy/controller-bundle.ts';
import type {ControllerMember} from '../deploy/controller-bundle.ts';
const members:ControllerMember[]=Array.from({length:5},(_,i)=>({id:'c'+(i+1),domain:'controller'+(i+1)+'.example',ip:'203.0.113.'+(i+1),peerPort:32001,userPort:32101,serverKey:'ed'+String(i+1).repeat(64),lease:String(i+1).repeat(64)}));
test('controller bundle pins exactly five distinct allocations and four-of-five consensus',()=>{
  const result=controllerBundle(Buffer.from('console.log("owned-contract");'),members);
  assert.equal(result.configuration.contract.consensus.threshold,80);assert.equal(result.configuration.contract.consensus.fallback.execute,false);assert.equal(result.configuration.contract.consensus.roundtime,2000);
  assert.deepEqual(result.configuration.contract.unl,members.map(m=>m.serverKey));assert.equal(result.configuration.contract.bin_path,'/usr/bin/node');
  assert.deepEqual(initialControllerConfig(members[0]).contract.unl,[members[0].serverKey]);assert.equal(initialControllerConfig().mesh.peer_discovery.enabled,false);
  assert.deepEqual(controllerBundle(Buffer.from('console.log("owned-contract");'),[...members].reverse()).archive,result.archive);
});
test('controller archive contains only the owned bundle and fixed HotPocket override',()=>{
  const script=Buffer.from('console.log("owned-contract");'),result=controllerBundle(script,members),files:Record<string,Buffer>={};let offset=0;
  while(result.archive.readUInt32LE(offset)===0x04034b50){const size=result.archive.readUInt32LE(offset+18),nameLength=result.archive.readUInt16LE(offset+26),extra=result.archive.readUInt16LE(offset+28),name=result.archive.subarray(offset+30,offset+30+nameLength).toString(),start=offset+30+nameLength+extra;files[name]=inflateRawSync(result.archive.subarray(start,start+size));offset=start+size;}
  assert.deepEqual(Object.keys(files),['contract.cjs','hp.cfg.override']);assert.deepEqual(files['contract.cjs'],script);assert.deepEqual(JSON.parse(files['hp.cfg.override'].toString()),result.configuration);assert.equal(result.archive.readUInt32LE(offset),0x02014b50);
});
test('controller preparation rejects missing members, repeated identities, IPs and unsafe peer targets',()=>{
  assert.throws(()=>controllerMembers(members.slice(0,4)));
  for(const key of ['id','domain','ip','serverKey','lease'] as const){const bad=structuredClone(members);bad[1][key]=bad[0][key];assert.throws(()=>controllerMembers(bad));}
  for(const domain of ['https://controller.example','user@controller.example','controller.example/path','localhost'])assert.throws(()=>controllerMembers(members.map((m,i)=>i===0?{...m,domain}:m)));
  assert.throws(()=>controllerBundle(Buffer.alloc(131073),members));assert.throws(()=>controllerBundle(Buffer.alloc(0),members));
});

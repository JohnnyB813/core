import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,head,hash} from './helpers.ts';
import {readProxy} from '../gateway/read-proxy.ts';
const policy={checkpoint:{height:5000000,hash},minimumHeight:5000000,maxLag:3,minPeers:2,maxLatencyMs:3000,freshnessMs:30000};
test('bounded data proxy normalizes valid chunked responses and forwards no caller credentials',async()=>{
  const seen:{path:string;authorization:unknown;cookie:unknown}[]=[];
  const upstream=await fixture((req,res)=>{seen.push({path:req.url!,authorization:req.headers.authorization,cookie:req.headers.cookie});const body=JSON.stringify(req.url?.endsWith('/hash')?{code:0,data:{hash}}:{...head,note:'Unicode é'});res.writeHead(200,{'content-type':'application/json'});res.write(body.slice(0,10));res.end(body.slice(10));});
  const handler=readProxy({id:'w1',url:upstream.url},policy),front=await fixture((req,res)=>{void handler(req,res);});
  try{for(const path of ['/chain/head','/chain/block/5000000/hash']){const r=await fetch(front.url+path,{headers:{authorization:'Bearer ignored',cookie:'ignored=value'}}),body=await r.text();assert.equal(r.status,200);assert.equal(r.headers.get('transfer-encoding'),null);assert.equal(Number(r.headers.get('content-length')),Buffer.byteLength(body));assert.equal(JSON.parse(body).code,0);}assert(seen.every(r=>r.authorization===undefined&&r.cookie===undefined));}finally{await front.close();await upstream.close();}
});
test('data proxy blocks writes, query strings and arbitrary URLs before upstream access',async()=>{
  let calls=0;const handler=readProxy({id:'w1',url:'https://worker.example'},policy,async()=>{calls++;return head;}),front=await fixture((req,res)=>{void handler(req,res);});
  try{for(const [path,method]of [['/wallet','GET'],['/chain/head?target=http://other','GET'],['/chain/head','POST'],['/chain/block/4294967296/hash','GET']])assert.equal((await fetch(front.url+path,{method})).status,404);assert.equal(calls,0);assert.throws(()=>readProxy({id:'w1',url:'http://worker.example'},policy),/HTTPS/);}finally{await front.close();}
});
test('data proxy rejects oversized bodies, invalid schemas, empty heads and wrong checkpoints',async()=>{
  let mode='large';const upstream=await fixture((req,res)=>{if(mode==='large')res.end(JSON.stringify({code:0,data:{padding:'x'.repeat(262145)}}));else if(mode==='empty')res.end(JSON.stringify({code:0,data:{...head.data,height:0}}));else if(mode==='hash')res.end(JSON.stringify({code:0,data:{hash:'b'.repeat(64)}}));else res.end('{}');});
  const handler=readProxy({id:'w1',url:upstream.url},policy),front=await fixture((req,res)=>{void handler(req,res);});
  try{for(const m of ['large','empty','hash','schema']){mode=m;const r=await fetch(front.url+(m==='hash'?'/chain/block/5000000/hash':'/chain/head'));assert.equal(r.status,502);assert.equal(r.headers.get('transfer-encoding'),null);await r.arrayBuffer();}}finally{await front.close();await upstream.close();}
});
test('a stalled chunked body reaches the data deadline and does not emit a partial success',async()=>{
  const upstream=await fixture((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');}),handler=readProxy({id:'w1',url:upstream.url},policy),front=await fixture((req,res)=>{void handler(req,res);});
  try{const began=Date.now(),r=await fetch(front.url+'/chain/head');assert.equal(r.status,502);assert(Date.now()-began<2200);assert.deepEqual(await r.json(),{error:'backend-unavailable'});}finally{await front.close();await upstream.close();}
});

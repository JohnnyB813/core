import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,stat,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {request} from 'node:https';
import {connect} from 'node:http2';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {stagePlatformTls} from '../gateway/platform-tls.ts';
const certificate='/contract/cfg/tlscert.pem',key='/contract/cfg/tlskey.pem';
function generate(cert:string,privateKey:string){assert.equal(spawnSync('openssl',['req','-x509','-newkey','ed25519','-nodes','-keyout',privateKey,'-out',cert,'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-days','1'],{stdio:'ignore'}).status,0);}
function get(path:string,ca?:Buffer,servername='localhost'):Promise<{status:number;body:string}>{return new Promise((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:8443,path,ca,servername,rejectUnauthorized:true,agent:false},res=>{let body='';res.on('data',chunk=>{body+=String(chunk);});res.once('end',()=>resolve({status:res.statusCode!,body}));});
  req.once('error',reject);req.setTimeout(3000,()=>req.destroy(new Error('TLS fixture timeout')));req.end();
});}
test('platform TLS bootstrap drops identity and preserves 503 over HTTPS/1 and HTTP/2',{timeout:15000},async t=>{
  await mkdir('/contract/cfg',{recursive:true});await mkdir('/run/poc',{recursive:true});generate(certificate,key);
  const before=createHash('sha256').update(await readFile(key)).digest('hex'),ca=await readFile(certificate);
  let logs='';const env={...process.env};delete env.PILOT_CONFIG;
  const child=spawn(process.execPath,['gateway/bootstrap.ts'],{env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>{logs=(logs+String(chunk)).slice(-16000);});child.stderr.on('data',chunk=>{logs=(logs+String(chunk)).slice(-16000);});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){
    // The root fixture deliberately has no CAP_KILL. Signal the dropped child
    // as its own UID rather than broadening the test container's capabilities.
    if(process.getuid?.()===0)assert.equal(spawnSync('/bin/kill',['-TERM',String(child.pid)],{uid:1000,gid:1000,stdio:'ignore'}).status,0);
    else child.kill('SIGTERM');
    await once(child,'exit');
  }await rm(certificate,{force:true});await rm(key,{force:true});await rm('/run/poc/host-tls.pem',{force:true});});
  let status:{status:number;body:string}|undefined;const deadline=Date.now()+7000;
  while(Date.now()<deadline){try{status=await get('/status',ca);break;}catch{await delay(50);}}
  assert(status,'Direct TLS listener did not start: '+logs);assert.equal(status.status,200);
  const body=JSON.parse(status.body);assert.equal(body.tls.enabled,true);assert.equal(body.tls.port,8443);assert.equal(body.workerReady,false);assert.equal(body.controllerQuorum,false);
  assert.match(logs,/"uid":1000/);assert(!logs.includes('BEGIN PRIVATE KEY'));
  assert.equal((await stat('/run/poc/host-tls.pem')).mode&0o777,0o600);
  assert.equal(createHash('sha256').update(await readFile(key)).digest('hex'),before,'Platform key was modified');
  await assert.rejects(get('/status'));
  await assert.rejects(get('/status',ca,'wrong.example'));
  assert.equal((await get('/chain/head',ca)).status,503);assert.equal((await get('/settings',ca)).status,403);
  const h2=connect('https://127.0.0.1:8443',{ca,servername:'localhost',rejectUnauthorized:true});t.after(()=>h2.close());
  const result=await new Promise<number>((resolve,reject)=>{let status=0;h2.once('error',reject);const stream=h2.request({':path':'/chain/head'});stream.on('response',headers=>{status=Number(headers[':status']);});stream.on('data',()=>{});stream.once('error',reject);stream.once('end',()=>resolve(status));stream.end();});
  assert.equal(result,503);h2.close();
});
test('missing, mismatched and expired platform profiles never enable a TLS listener',{timeout:5000},async()=>{
  const cert='/run/poc/invalid-profile-cert.pem',firstKey='/run/poc/invalid-profile-key.pem',wrongKey='/run/poc/other-profile-key.pem';generate(cert,firstKey);
  assert.equal(spawnSync('openssl',['genpkey','-algorithm','ed25519','-out',wrongKey],{stdio:'ignore'}).status,0);
  try{
    const missing=await stagePlatformTls([{name:'host',certificate:'/run/poc/does-not-exist',privateKey:wrongKey}]);assert.equal(missing.pemFiles.length,0);assert.deepEqual(missing.unavailable,['host:missing']);
    const mismatch=await stagePlatformTls([{name:'host',certificate:cert,privateKey:wrongKey}]);assert.equal(mismatch.pemFiles.length,0);assert.deepEqual(mismatch.unavailable,['host:invalid']);
    const expired=await stagePlatformTls([{name:'host',certificate:cert,privateKey:firstKey}],Date.now()+2*24*60*60*1000);assert.equal(expired.pemFiles.length,0);
  }finally{for(const file of [cert,firstKey,wrongKey])await rm(file,{force:true});}
});

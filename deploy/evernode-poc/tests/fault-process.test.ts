import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {request as httpsRequest} from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
import {FaultController} from '../fault/controller.ts';
import {FileControlStore} from '../fault/store.ts';
import {signControl} from '../fault/protocol.ts';
import type {ControlRequest} from '../fault/protocol.ts';
import {startControlServer} from '../fault/server.ts';
import {SetupInstaller,signSetup} from '../fault/setup.ts';
import type {SetupRequest} from '../fault/setup.ts';
import {loadHotPocket} from '../shared/hotpocket.ts';

test('signed TLS control pauses only its child, rejects unauthorized requests and automatically restores it',{timeout:15000},async t=>{
  assert.equal(process.getuid?.(),1000,'Signal fixture must run without root privileges');
  const directory=await mkdtemp('/run/poc/fault-process-');
  const certificate=directory+'/cert.pem',key=directory+'/key.pem',combined=directory+'/combined.pem';
  assert.equal(spawnSync('openssl',['req','-x509','-newkey','ed25519','-nodes','-keyout',key,'-out',certificate,'-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-days','1'],{stdio:'ignore'}).status,0);
  const ca=await readFile(certificate);await writeFile(combined,Buffer.concat([ca,Buffer.from('\n'),await readFile(key)]),{mode:0o600});
  const child=spawn(process.execPath,['-e','setInterval(()=>process.send?.("heartbeat"),20)'],{stdio:['ignore','ignore','ignore','ipc']});
  let beats=0,pauses=0,resumes=0;child.on('message',()=>{beats++;});
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGCONT');child.kill('SIGTERM');await once(child,'exit');}});
  const keys=generateKeyPairSync('ed25519');
  const config={contractId:'fixture-pilot',targetId:'w1',operatorPublicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64')};
  const target={pause:async()=>{assert.equal(child.kill('SIGSTOP'),true);pauses++;},resume:async()=>{assert.equal(child.kill('SIGCONT'),true);resumes++;}};
  const store=new FileControlStore(directory+'/controls.json'),controller=await FaultController.create(config,target,store);
  const reporter=await loadHotPocket().generateKeys(),reporterSecret=Buffer.from(reporter.privateKey).toString('hex');
  const installer=new SetupInstaller({...config,generation:()=>controller.status().generation,reporterPublicKey:Buffer.from(reporter.publicKey).toString('hex'),directory:directory+'/installed'});
  const control=await startControlServer(controller,8444,combined,installer);
  t.after(async()=>{await control.close();});
  async function call(path:string,body?:unknown,signature?:string,trusted=true):Promise<{status:number;body:Record<string,unknown>}>{
    return new Promise((resolve,reject)=>{
      const encoded=body?JSON.stringify(body):undefined;
      const request=httpsRequest({hostname:'127.0.0.1',port:8444,path,method:encoded?'POST':'GET',rejectUnauthorized:true,...(trusted?{ca}:{}),agent:false,headers:{...(encoded?{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}:{}),...(signature?{'x-pilot-signature':signature}:{})}},response=>{
        const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
      });request.setTimeout(2000,()=>request.destroy(new Error('Fixture HTTPS deadline')));request.on('error',reject);request.end(encoded);
    });
  }
  const waitFor=async(condition:()=>boolean)=>{const until=Date.now()+2500;while(!condition()){if(Date.now()>until)throw new Error('Fixture process condition timed out');await delay(20);}};
  await waitFor(()=>beats>=3);
  await assert.rejects(call('/pilot/status',undefined,undefined,false));
  const state=await call('/pilot/status');assert.equal(state.status,200);
  const setup:SetupRequest={version:1,contractId:config.contractId,targetId:'w1',generation:controller.status().generation,operationId:randomUUID(),issuedAt:Date.now(),reporterKey:reporterSecret,config:{contractId:config.contractId,controllers:['c1','c2','c3','c4','c5'],controllerEndpoints:[1,2,3,4,5].map(i=>({id:'c'+i,url:'wss://c'+i+'.example/',serverKey:'ed'+String(i).repeat(64)})),backends:[1,2,3].map(i=>({id:'w'+i,url:'http://w'+i+'.example'})),reference:'https://reference.example',policy:{checkpoint:{height:5000000,hash:'a'.repeat(64)},minimumHeight:5000000,maxLag:3,minPeers:2,maxLatencyMs:3000,freshnessMs:30000}}};
  assert.equal((await call('/pilot/setup')).body.installed,false);
  assert.equal((await call('/pilot/setup',setup,signSetup(setup,generateKeyPairSync('ed25519').privateKey))).status,403);
  assert.equal((await call('/pilot/setup')).body.installed,false);
  const installed=await call('/pilot/setup',setup,signSetup(setup,keys.privateKey));assert.equal(installed.status,200);assert.equal(installed.body.installed,true);assert.equal(JSON.stringify(installed.body).includes(reporterSecret),false);
  assert.equal((await readFile(directory+'/installed/reporter.key','utf8')).trim(),reporterSecret);
  const command:ControlRequest={version:1,contractId:config.contractId,targetId:'w1',generation:controller.status().generation,operationId:randomUUID(),action:'pause',issuedAt:Date.now(),durationMs:500};
  const bad=signControl(command,generateKeyPairSync('ed25519').privateKey);
  assert.equal((await call('/pilot/control',command,bad)).status,403);assert.equal(pauses,0);
  const signature=signControl(command,keys.privateKey);
  const result=await call('/pilot/control',command,signature);assert.equal(result.status,200);assert.equal(pauses,1);
  await delay(60);const stopped=beats;await delay(100);assert.equal(beats,stopped,'Child continued executing while paused');
  assert.equal((await call('/pilot/control',command,signature)).status,200);assert.equal(pauses,1,'Duplicate request signaled twice');
  assert.equal((await call('/pilot/control',{...command,pid:1},signature)).status,409);assert.equal(pauses,1);
  await waitFor(()=>beats>stopped);assert.equal(resumes,1);assert.equal(controller.status().paused,false);
  assert.equal((await call('/settings')).status,404);
  const reopened=await FaultController.create(config,target,new FileControlStore(directory+'/controls.json'));
  await reopened.execute(command,signature);assert.equal(pauses,1,'Reopening the store replayed a pause');
  assert.equal(reopened.status().paused,false);
});

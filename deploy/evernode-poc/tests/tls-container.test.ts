import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {readFile} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {WebSocketServer}=require('ws');
test('SDK rejects an untrusted TLS certificate before upgrade and caps trusted WSS frames',{timeout:15000},async t=>{
  assert.equal(spawnSync('openssl',['req','-x509','-newkey','ed25519','-nodes','-keyout','/run/poc/fixture-key.pem','-out','/run/poc/fixture-cert.pem','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-days','1'],{stdio:'ignore'}).status,0);
  const server=createServer({key:await readFile('/run/poc/fixture-key.pem'),cert:await readFile('/run/poc/fixture-cert.pem')});
  const wss=new WebSocketServer({server});
  let upgrades=0,closeCode:number|null=null;
  wss.on('connection',(socket:{send:(data:Buffer)=>void;on:(event:string,handler:(code:number)=>void)=>void})=>{upgrades++;socket.on('close',code=>{closeCode=code;});socket.send(Buffer.alloc(300000,0x61));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{wss.close();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');
  const url='wss://127.0.0.1:'+address.port+'/';
  async function attempt(trusted:boolean){
    const child=spawn(process.execPath,['tests/hp-client-child.ts',url],{env:{...process.env,NODE_TLS_REJECT_UNAUTHORIZED:'1',NODE_EXTRA_CA_CERTS:trusted?'/run/poc/fixture-cert.pem':''},stdio:'ignore'});
    const [code]=await once(child,'exit');assert.equal(code,0);
  }
  await attempt(false);assert.equal(upgrades,0,'Untrusted certificate reached the WebSocket layer');
  await attempt(true);
  const deadline=Date.now()+2000;while(closeCode===null&&Date.now()<deadline)await delay(20);
  assert.equal(upgrades,1);assert.equal(closeCode,1009,'Oversized WebSocket frame was not rejected');
});

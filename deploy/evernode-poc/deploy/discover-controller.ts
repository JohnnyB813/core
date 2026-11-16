import {createRequire} from 'node:module';
import {generateKeyPairSync,randomBytes,sign,verify,createPublicKey} from 'node:crypto';
import {object} from '../shared/health.ts';
type Socket={on:(event:string,fn:(...args:unknown[])=>void)=>void;send:(text:string)=>void;terminate:()=>void};
type Factory=(url:string,options:Record<string,unknown>)=>Socket;
const factory:Factory=(url,options)=>{const require=createRequire(import.meta.url),WebSocket=require('ws');return new WebSocket(url,options);};
/** Initial public identity discovery, authenticated by the host's CA-validated
 * WSS origin and a native Ed25519 challenge. Uses a disposable client key,
 * sends no contract input, and returns a pin for every later connection. */
export async function discoverController(urlText:string,contractId:string,create:Factory=factory,timeoutMs=5000):Promise<{publicKey:string;contractId:string;contractVersion:string;hpVersion:string;source:'strict-wss-ed25519-challenge'}>{
 const url=new URL(urlText);if(url.protocol!=='wss:'||url.href!==urlText||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.port||!(/^[a-f0-9-]{36}$/).test(contractId)||!Number.isInteger(timeoutMs)||timeoutMs<20||timeoutMs>5000)throw new Error('Invalid certificate-authenticated discovery target');
 const keys=generateKeyPairSync('ed25519'),publicKey='ed'+keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'),challenge=randomBytes(16).toString('hex');
 return new Promise((resolve,reject)=>{
  let socket:Socket|undefined,done=false,stage=0,version='',hpVersion='';
  const finish=(result?:{publicKey:string;contractId:string;contractVersion:string;hpVersion:string;source:'strict-wss-ed25519-challenge'})=>{if(done)return;done=true;clearTimeout(timer);socket?.terminate();result?resolve(result):reject(new Error('Certificate-authenticated controller discovery failed'));};
  const timer=setTimeout(()=>finish(),timeoutMs);
  try{
   socket=create(url.href,{rejectUnauthorized:true,followRedirects:false,maxPayload:65536,handshakeTimeout:Math.min(timeoutMs,3000),perMessageDeflate:false});
   socket.on('error',()=>finish());socket.on('close',()=>finish());socket.on('unexpected-response',()=>finish());
   socket.on('message',raw=>{if(done)return;try{
    if(!(raw instanceof Uint8Array)||raw.byteLength>65536)throw new Error();const body=object(JSON.parse(Buffer.from(raw).toString('utf8')));
    if(stage===0){
     if(body.type!=='user_challenge'||body.contract_id!==contractId||typeof body.hp_version!=='string'||!/^0\.6\.\d+$/.test(body.hp_version)||typeof body.contract_version!=='string'||!(/^[a-zA-Z0-9._-]{1,40}$/).test(body.contract_version)||typeof body.challenge!=='string'||!(/^(?:[a-f0-9]{2}){16,256}$/i).test(body.challenge))throw new Error();
     version=body.contract_version;hpVersion=body.hp_version;stage=1;
     socket!.send(JSON.stringify({type:'user_challenge_response',sig:sign(null,Buffer.from(body.challenge),keys.privateKey).toString('hex'),pubkey:publicKey,server_challenge:challenge,protocol:'json'}));return;
    }
    if(stage!==1||body.type!=='server_challenge_response'||typeof body.pubkey!=='string'||!/^ed[a-f0-9]{64}$/.test(body.pubkey)||typeof body.sig!=='string'||!(/^[a-f0-9]{128}$/i).test(body.sig))throw new Error();
    const serverKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(body.pubkey.slice(2),'hex')]),format:'der',type:'spki'});
    if(!verify(null,Buffer.from(challenge+contractId+version),serverKey,Buffer.from(body.sig,'hex')))throw new Error();
    stage=2;finish({publicKey:body.pubkey,contractId,contractVersion:version,hpVersion,source:'strict-wss-ed25519-challenge'});
   }catch{finish();}});
  }catch{finish();}
 });
}

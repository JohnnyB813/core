import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {allowedReadPath,boundedJson,endpoint} from '../shared/http.ts';
import {object,parseHead,parseHash} from '../shared/health.ts';
import type {Policy} from '../shared/health.ts';
import type {Backend} from './config.ts';
export const READ_PROXY_PORT=9201;
type Reader=(url:string,timeoutMs:number,maxBytes:number)=>Promise<unknown>;
function reply(res:ServerResponse,status:number,body:unknown){
  if(res.destroyed)return;
  const encoded=JSON.stringify(body);
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','content-length':Buffer.byteLength(encoded)});res.end(encoded);
}
/** Fixed-origin, bounded buffering accepts a worker's chunked HTTPS response
 * without relaxing HAProxy's Content-Length or response-size defenses. */
export function readProxy(backend:Backend,policy:Policy,read:Reader=boundedJson){
  const origin=endpoint(backend.url),fixed=structuredClone(policy);
  if(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['127.0.0.1','localhost'].includes(origin.hostname)))throw new Error('Remote worker reads require verified HTTPS');
  let active=0;
  return async(req:IncomingMessage,res:ServerResponse):Promise<void>=>{
    if(req.method!=='GET'||!allowedReadPath(req.url||'')){reply(res,404,{error:'not-found'});return;}
    if(active>=16){reply(res,503,{error:'backend-busy'});return;}
    active++;
    try{
      const body=await read(origin.origin+req.url,1500,262144);
      if(req.url==='/chain/head'){const head=parseHead(body);if(!head.synced||head.height<fixed.minimumHeight)throw new Error('Worker head is not ready');}
      else if(req.url!.endsWith('/hash')){const hash=parseHash(body);if(req.url==='/chain/block/'+fixed.checkpoint.height+'/hash'&&hash!==fixed.checkpoint.hash)throw new Error('Checkpoint differs');}
      else{const value=object(body);if(value.code!==0||!value.data||typeof value.data!=='object'||Array.isArray(value.data))throw new Error('Invalid header response');}
      if(Buffer.byteLength(JSON.stringify(body))>262144)throw new Error('Encoded response cap');
      reply(res,200,body);
    }catch{reply(res,502,{error:'backend-unavailable'});}
    finally{active--;}
  };
}
export async function startReadProxy(backend:Backend,policy:Policy,port:number){
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid loopback read port');
  const handle=readProxy(backend,policy),server=createServer({maxHeaderSize:8192},(req,res)=>{void handle(req,res).catch(()=>{if(!res.destroyed)res.destroy();});});
  server.requestTimeout=2000;server.headersTimeout=2000;server.keepAliveTimeout=1000;server.maxConnections=128;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return server;
}

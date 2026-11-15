import type {IncomingMessage,ServerResponse} from 'node:http';
import {boundedJson} from '../shared/http.ts';
import {parseHead,parseHash,parsePeers,object} from '../shared/health.ts';

export function workerReadPath(path:string):boolean{
  return path==='/chain/head'||path==='/peers/connected/connection'||/^\/chain\/block\/[1-9][0-9]{0,9}\/(hash|header)$/.test(path)&&Number(path.split('/')[3])<=0xffffffff;
}
// The target is a validated, fixed loopback port. Neither URL nor headers come
// from a public request. This adapter cannot reach the private RPC on port 3000.
export function workerApi(port:number){
  if(!Number.isInteger(port)||port<1||port>65535||port===3000)throw new Error('Invalid filtered worker RPC port');
  let active=0;
  return async(req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
    if(req.method!=='GET'||!workerReadPath(req.url||''))return false;
    res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
    if(active>=16){res.writeHead(503);res.end('{"error":"worker-busy"}');return true;}
    active++;
    try{
      const body=await boundedJson('http://127.0.0.1:'+port+req.url,1500);
      if(req.url==='/chain/head')parseHead(body);
      else if(req.url==='/peers/connected/connection')parsePeers(body);
      else if(req.url!.endsWith('/hash'))parseHash(body);
      else{const value=object(body);if(value.code!==0||!value.data||typeof value.data!=='object'||Array.isArray(value.data))throw new Error('Invalid header response');}
      const encoded=JSON.stringify(body);
      if(Buffer.byteLength(encoded)>262144)throw new Error('Worker response too large');
      res.writeHead(200);res.end(encoded);
    }catch{res.writeHead(502);res.end('{"error":"filtered-worker-unavailable"}');}
    finally{active--;}
    return true;
  };
}

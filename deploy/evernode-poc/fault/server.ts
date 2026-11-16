import {createServer} from 'node:https';
import {readFile} from 'node:fs/promises';
import {ControlError} from './protocol.ts';
import type {FaultController} from './controller.ts';
import type {SetupInstaller} from './setup.ts';
import type {ConfigUpdater} from './config-update.ts';
import type {IncomingMessage,ServerResponse} from 'node:http';
export type ControlService={status:()=>Promise<unknown>;execute:(value:unknown,signature:string)=>Promise<unknown>;evidence?:()=>Promise<string>};
export async function startControlServer(controller:FaultController,port:number,pemFile:string,installer?:SetupInstaller,observations?:()=>Promise<unknown>,readAdapter?:(req:IncomingMessage,res:ServerResponse)=>Promise<boolean>,updater?:ConfigUpdater,services:Record<string,ControlService>={}){
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid control port');
  if(Object.keys(services).some(path=>!['/pilot/canary','/pilot/experiment'].includes(path)))throw new Error('Unknown finite control service');
  const pem=await readFile(pemFile,'utf8');
  const certificates=pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)?.join('\n');
  if(!certificates||Buffer.byteLength(pem)>196608)throw new Error('Valid staged TLS material is required for control API');
  const server=createServer({key:pem,cert:certificates,minVersion:'TLSv1.2',maxHeaderSize:8192},async(req,res)=>{
    const reply=(status:number,value:unknown)=>{if(!res.headersSent){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}};
    if(req.method==='GET'&&req.url==='/pilot/status'){try{reply(200,{...controller.status(),...(observations?{observations:await observations()}:{})});}catch{reply(503,{error:'observations-unavailable'});}return;}
    if(req.method==='GET'&&req.url==='/pilot/setup'&&installer){try{reply(200,await installer.status());}catch{reply(503,{error:'setup-unavailable'});}return;}
    if(req.method==='GET'&&req.url==='/pilot/configuration'&&updater){try{const current=await updater.current();reply(200,{revision:current.revision,configHash:current.configHash,operationId:current.operationId});}catch{reply(503,{error:'configuration-unavailable'});}return;}
    const service=req.url&&Object.hasOwn(services,req.url)?services[req.url]:undefined;
    if(req.method==='GET'&&service){try{reply(200,await service.status());}catch{reply(503,{error:'finite-status-unavailable'});}return;}
    if(req.method==='GET'&&req.url==='/pilot/experiment/evidence'&&services['/pilot/experiment']?.evidence){try{const text=await services['/pilot/experiment'].evidence!();if(Buffer.byteLength(text)>16777216)throw new Error('Evidence cap');res.writeHead(200,{'content-type':'application/x-ndjson','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(text);}catch{reply(503,{error:'evidence-unavailable'});}return;}
    if(req.method==='GET'&&req.url==='/pilot/dashboard'&&services['/pilot/experiment']){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff'});res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Evernode Warthog trial</title><style>body{max-width:60rem;margin:3rem auto;padding:0 1rem;font:16px system-ui;background:#101726;color:#edf1fa}h1{font-size:1.5rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#1b263a;padding:1rem;border-radius:.5rem}a{color:#99d7ff}</style><h1>Evernode Warthog trial</h1><p>Finite validation run. Funding and signing stay with the operator.</p><p><a href="/pilot/experiment/evidence">Download measured observations</a></p><pre id="status">Loading current measurements…</pre><script>async function refresh(){try{const r=await fetch("/pilot/experiment",{cache:"no-store",signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error();document.getElementById("status").textContent=JSON.stringify(await r.json(),null,2)}catch{document.getElementById("status").textContent="Measurements unavailable. Retrying…"}}refresh();setInterval(refresh,5000)</script></html>');return;}
    if(req.method==='GET'&&readAdapter){try{if(await readAdapter(req,res))return;}catch{reply(502,{error:'read-unavailable'});return;}}
    const setup=req.url==='/pilot/setup'&&installer!==undefined;
    const configuration=req.url==='/pilot/configuration'&&updater!==undefined;
    if(req.method!=='POST'||(req.url!=='/pilot/control'&&!setup&&!configuration&&!service)){reply(404,{error:'not-found'});return;}
    const signature=req.headers['x-pilot-signature'];
    if(typeof signature!=='string'||signature.length!==88){reply(403,{error:'unauthorized'});return;}
    const chunks:Buffer[]=[];let size=0;
    try{
      for await(const chunk of req){size+=chunk.length;if(size>(service?131072:setup||configuration?16384:4096)){reply(413,{error:'body-too-large'});req.destroy();return;}chunks.push(chunk);}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(service){reply(200,await service.execute(value,signature));return;}
      if(setup){reply(200,await installer!.execute(value,signature));return;}
      if(configuration){const current=await updater!.execute(value,signature);reply(200,{revision:current.revision,configHash:current.configHash,operationId:current.operationId});return;}
      const result=await controller.execute(value,signature);reply(result.receipt.state==='applied'?200:409,result);
    }catch(error){reply(error instanceof ControlError?(error.code==='unauthorized'||error.code==='wrong-target'?403:409):503,{error:error instanceof ControlError?error.code:'control-unavailable'});}
  });
  server.requestTimeout=2000;server.headersTimeout=2000;server.keepAliveTimeout=1000;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  const timer=setInterval(()=>{void controller.sweep().catch(()=>{console.error(JSON.stringify({event:'control-resume-pending'}));});},1000);timer.unref();
  return{server,close:async()=>{clearInterval(timer);await controller.restore();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

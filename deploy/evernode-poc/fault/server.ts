import {createServer} from 'node:https';
import {readFile} from 'node:fs/promises';
import {ControlError} from './protocol.ts';
import type {FaultController} from './controller.ts';
import type {SetupInstaller} from './setup.ts';
import type {IncomingMessage,ServerResponse} from 'node:http';
export async function startControlServer(controller:FaultController,port:number,pemFile:string,installer?:SetupInstaller,observations?:()=>Promise<unknown>,readAdapter?:(req:IncomingMessage,res:ServerResponse)=>Promise<boolean>){
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid control port');
  const pem=await readFile(pemFile,'utf8');
  const certificates=pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)?.join('\n');
  if(!certificates||Buffer.byteLength(pem)>196608)throw new Error('Valid staged TLS material is required for control API');
  const server=createServer({key:pem,cert:certificates,minVersion:'TLSv1.2',maxHeaderSize:8192},async(req,res)=>{
    const reply=(status:number,value:unknown)=>{if(!res.headersSent){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}};
    if(req.method==='GET'&&req.url==='/pilot/status'){try{reply(200,{...controller.status(),...(observations?{observations:await observations()}:{})});}catch{reply(503,{error:'observations-unavailable'});}return;}
    if(req.method==='GET'&&req.url==='/pilot/setup'&&installer){try{reply(200,await installer.status());}catch{reply(503,{error:'setup-unavailable'});}return;}
    if(req.method==='GET'&&readAdapter){try{if(await readAdapter(req,res))return;}catch{reply(502,{error:'read-unavailable'});return;}}
    const setup=req.url==='/pilot/setup'&&installer!==undefined;
    if(req.method!=='POST'||(req.url!=='/pilot/control'&&!setup)){reply(404,{error:'not-found'});return;}
    const signature=req.headers['x-pilot-signature'];
    if(typeof signature!=='string'||signature.length!==88){reply(403,{error:'unauthorized'});return;}
    const chunks:Buffer[]=[];let size=0;
    try{
      for await(const chunk of req){size+=chunk.length;if(size>(setup?16384:4096)){reply(413,{error:'body-too-large'});req.destroy();return;}chunks.push(chunk);}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(setup){reply(200,await installer!.execute(value,signature));return;}
      const result=await controller.execute(value,signature);reply(result.receipt.state==='applied'?200:409,result);
    }catch(error){reply(error instanceof ControlError?(error.code==='unauthorized'||error.code==='wrong-target'?403:409):503,{error:error instanceof ControlError?error.code:'control-unavailable'});}
  });
  server.requestTimeout=2000;server.headersTimeout=2000;server.keepAliveTimeout=1000;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  const timer=setInterval(()=>{void controller.sweep().catch(()=>{console.error(JSON.stringify({event:'control-resume-pending'}));});},1000);timer.unref();
  return{server,close:async()=>{clearInterval(timer);await controller.restore();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

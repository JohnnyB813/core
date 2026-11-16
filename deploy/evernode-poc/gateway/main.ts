import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {Server,RequestListener} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {parseConfig,haproxyConfig} from './config.ts';
import {GatewayAgent} from './agent.ts';
import {ControllerPoller,commonReplies} from './controllers.ts';
import {gatewayTls} from './platform-tls.ts';
import {startReadProxy,READ_PROXY_PORT} from './read-proxy.ts';
const config=parseConfig(JSON.parse(await readFile(process.env.PILOT_CONFIG||new URL('./trial-config.json',import.meta.url),'utf8')));
const agent=new GatewayAgent(config);
const servers:Server[]=[];
function serve(port:number,handler:RequestListener){return new Promise<void>((resolve,reject)=>{const server=createServer(handler);server.requestTimeout=2000;server.headersTimeout=2000;server.keepAliveTimeout=1000;servers.push(server);server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}
await mkdir('/run/poc',{recursive:true});
const cfg='/run/poc/haproxy.cfg';
const tls=gatewayTls();
const readProxyPorts=config.backends.map((_backend,index)=>READ_PROXY_PORT+index);
await writeFile(cfg,haproxyConfig(config,tls.pemFiles,readProxyPorts),{mode:0o600});
const check=spawnSync('/usr/sbin/haproxy',['-c','-f',cfg],{encoding:'utf8'});
if(check.status!==0)throw new Error('Invalid HAProxy configuration: '+check.stderr);
await serve(9090,(req,res)=>{const allowed=req.method==='GET'&&['/status','/healthz'].includes(req.url||'');res.writeHead(allowed?200:404,{'content-type':'application/json'});res.end(JSON.stringify(allowed?{...agent.status(),tls:{enabled:tls.pemFiles.length>0,port:tls.pemFiles.length?8443:null,expiresAt:tls.expiresAt}}:{error:'not-found'}));});
for(const [index,backend] of config.backends.entries())await serve(9101+index,(req,res)=>{const ready=req.method==='GET'&&req.url==='/ready'&&agent.ready(backend.id);res.writeHead(ready?200:503,{'content-type':'application/json'});res.end(JSON.stringify({ready}));});
for(const [index,backend] of config.backends.entries())servers.push(await startReadProxy(backend,config.policy,readProxyPorts[index]));
const proxy=spawn('/usr/sbin/haproxy',['-W','-db','-f',cfg],{stdio:'inherit'});
let stopping=false;
const stopSignal=new AbortController();
const poller=config.controllerEndpoints.length?new ControllerPoller(config.contractId,config.controllerEndpoints):null;
async function stop(){if(stopping)return;stopping=true;stopSignal.abort();await poller?.close();proxy.kill('SIGTERM');for(const server of servers){server.closeAllConnections();server.close();}}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
proxy.on('error',async error=>{console.error(String(error));process.exitCode=1;await stop();});
proxy.on('exit',async code=>{if(!stopping){process.exitCode=code||1;await stop();}});
console.log(JSON.stringify({event:'gateway-start',controllerTransport:'not-connected',admission:'closed-until-verified-controller-quorum',backends:config.backends.map(b=>b.id)}));
const polling=(async()=>{if(!poller)return;while(!stopping){const histories=await poller.poll();const now=Date.now();agent.registry.accept(commonReplies(histories,config.contractId,now),now);agent.controllerTransport=agent.registry.quorumFresh(now)?'connected':'waiting-for-quorum';await delay(2000,undefined,{signal:stopSignal.signal}).catch(error=>{if(!stopping)throw error;});}})();
while(!stopping){const started=performance.now();await agent.sample();if(stopping)break;console.log(JSON.stringify({event:'health-sample',at:new Date().toISOString(),status:agent.status()}));await delay(Math.max(0,10000-(performance.now()-started)),undefined,{signal:stopSignal.signal}).catch(error=>{if(!stopping)throw error;});}
await polling;

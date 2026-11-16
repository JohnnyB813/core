import {endpoint} from '../shared/http.ts';
import {isHash,isHeight,object} from '../shared/health.ts';
import type {Policy} from '../shared/health.ts';
import type {ControllerEndpoint} from './controllers.ts';
export type Backend = {id:string;url:string};
export type GatewayConfig = {contractId:string;controllers:string[];controllerEndpoints:ControllerEndpoint[];backends:Backend[];reference:string;policy:Policy};
export function parseConfig(value:unknown):GatewayConfig {
  const c=object(value), p=object(c.policy), checkpoint=object(p.checkpoint);
  if(typeof c.contractId!=='string'||!c.contractId||!Array.isArray(c.controllers)||c.controllers.length!==5||c.controllers.some(v=>typeof v!=='string'||!v)||new Set(c.controllers).size!==5)throw new Error('Invalid fixed controller set');
  if(!Array.isArray(c.backends)||c.backends.length>10)throw new Error('Expected at most ten backends');
  const backends=c.backends.map(value=>{const b=object(value);if(typeof b.id!=='string'||!/^[a-z][a-z0-9]{0,15}$/.test(b.id)||typeof b.url!=='string')throw new Error('Invalid backend');return{id:b.id,url:endpoint(b.url).origin};});
  if(new Set(backends.map(b=>b.id)).size!==backends.length||new Set(backends.map(b=>b.url)).size!==backends.length)throw new Error('Duplicate backend identity or endpoint');
  if(typeof c.reference!=='string'||!isHeight(checkpoint.height)||checkpoint.height===0||!isHash(checkpoint.hash)||!isHeight(p.minimumHeight)||p.minimumHeight<checkpoint.height)throw new Error('Invalid bootstrap policy');
  const pins=c.controllerEndpoints??[];
  if(!Array.isArray(pins)||(pins.length!==0&&pins.length!==5))throw new Error('All five controller pins are required together');
  if(pins.length&&backends.length!==3)throw new Error('Connected pilot requires exactly three workers');
  const controllerEndpoints=pins.map(value=>{const pin=object(value);if(typeof pin.id!=='string'||!(c.controllers as string[]).includes(pin.id)||typeof pin.serverKey!=='string'||!/^ed[0-9a-f]{64}$/i.test(pin.serverKey)||typeof pin.url!=='string'||/\s/.test(pin.url))throw new Error('Invalid controller pin');const url=new URL(pin.url);if(url.protocol!=='wss:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Controller requires an authenticated WSS origin');return{id:pin.id,serverKey:pin.serverKey.toLowerCase(),url:url.toString()};});
  for(const field of ['id','serverKey','url'] as const)if(new Set(controllerEndpoints.map(pin=>pin[field])).size!==controllerEndpoints.length)throw new Error('Repeated controller pin');
  for(const key of ['maxLag','minPeers','maxLatencyMs','freshnessMs'])if(!Number.isSafeInteger(p[key])||Number(p[key])<=0)throw new Error('Invalid '+key);
  if(Number(p.maxLag)>10||Number(p.minPeers)<2||Number(p.maxLatencyMs)>3000||Number(p.freshnessMs)>30000)throw new Error('Policy exceeds pilot bounds');
  return{contractId:c.contractId,controllers:c.controllers as string[],controllerEndpoints,backends,reference:endpoint(c.reference).origin,policy:{checkpoint:{height:checkpoint.height,hash:checkpoint.hash},minimumHeight:p.minimumHeight,maxLag:Number(p.maxLag),minPeers:Number(p.minPeers),maxLatencyMs:Number(p.maxLatencyMs),freshnessMs:Number(p.freshnessMs)}};
}
export function haproxyConfig(config:GatewayConfig,pemFiles:string[]=[],readProxyPorts?:number[]):string {
  if(pemFiles.some(file=>!/^\/run\/poc\/(host|instance)-tls\.pem$/.test(file)))throw new Error('Unexpected TLS staging path');
  if(readProxyPorts&&(readProxyPorts.length!==config.backends.length||new Set(readProxyPorts).size!==readProxyPorts.length||readProxyPorts.some(port=>!Number.isInteger(port)||port<1||port>65535)))throw new Error('Invalid fixed read-proxy ports');
  const servers=config.backends.map((backend,i)=>{
    const url=endpoint(backend.url);
    const normalized=readProxyPorts?.[i],tls=!normalized&&url.protocol==='https:'?' ssl verify required ca-file /etc/ssl/cert.pem sni str('+url.hostname+')':'';
    const address=normalized?'127.0.0.1:'+normalized:url.hostname+':'+(url.port||(url.protocol==='https:'?'443':'80'));
    return '  server '+backend.id+' '+address+tls+' check addr 127.0.0.1 port '+(9101+i)+' inter 1s fall 1 rise 1 init-state fully-down';
  });
  return `global
  log stdout format raw local0
  maxconn 128
defaults
  log global
  mode http
  option httplog
  option http-server-close
  timeout connect 1s
  timeout client 8s
  timeout server 3s
  timeout http-request 3s
  timeout queue 1s
  retries 1
frontend public_readonly
  bind 0.0.0.0:8080
${pemFiles.length?'  bind 0.0.0.0:8443 ssl '+pemFiles.map(file=>'crt '+file).join(' ')+' ssl-min-ver TLSv1.2 alpn h2,http/1.1':''}
  stick-table type ip size 10k expire 30s store http_req_rate(10s)
  http-request track-sc0 src
  http-request deny deny_status 429 if { sc_http_req_rate(0) gt 600 }
  http-request deny deny_status 405 unless { method GET }
  http-request deny deny_status 400 if { query -m found }
  acl block_path path_beg /chain/block/
  http-request set-var(txn.blockheight) path,regsub(^/chain/block/,,),field(1,/) if block_path
  http-request deny deny_status 400 if block_path { var(txn.blockheight) -m int gt 4294967295 }
  acl allowed_status path -m str /status /healthz
  acl allowed_api path_reg ^/chain/head$ ^/chain/block/[1-9][0-9]{0,9}/(hash|header)$
  http-request deny deny_status 403 unless allowed_status or allowed_api
  use_backend local_status if allowed_status
  default_backend workers
backend local_status
  server agent 127.0.0.1:9090
backend workers
  balance leastconn
  option redispatch 1
  retry-on conn-failure empty-response response-timeout 502 503
  option httpchk GET /ready
  http-check expect status 200
  http-reuse never
  http-response deny deny_status 502 if { res.hdr(transfer-encoding) -m found }
  http-response deny deny_status 502 unless { res.hdr(content-length) -m reg ^[0-9]+$ }
  http-response deny deny_status 502 if { res.hdr(content-length) -m int gt 262144 }
  http-response set-header X-Poc-Backend %[srv_name]
${servers.join('\n')}
`;
}

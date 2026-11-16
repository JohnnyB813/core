// A supervisor has already staged the platform certificates and dropped identity.
import {readFile,stat} from 'node:fs/promises';
import {X509Certificate,createPrivateKey} from 'node:crypto';
import {setGatewayTls} from './platform-tls.ts';
import type {GatewayTls} from './platform-tls.ts';
if(process.getuid?.()!==1000)throw new Error('Supervised gateway requires UID 1000');
const metadata=JSON.parse(await readFile('/run/poc/tls-meta.json','utf8')) as GatewayTls;
if(!Array.isArray(metadata.pemFiles)||!metadata.pemFiles.length||metadata.pemFiles.some(path=>!/^\/run\/poc\/(host|instance)-tls\.pem$/.test(path)))throw new Error('Staged TLS metadata is invalid');
let expiresAt:number|null=null;
for(const path of metadata.pemFiles){
  const information=await stat(path);if(!information.isFile()||information.size>196608||(information.mode&0o777)!==0o600)throw new Error('Staged TLS file is invalid');
  const pem=await readFile(path),leaf=new X509Certificate(pem);if(!leaf.checkPrivateKey(createPrivateKey(pem))||Date.parse(leaf.validTo)<Date.now())throw new Error('Staged TLS profile is invalid');
  const expiry=Date.parse(leaf.validTo);expiresAt=expiresAt===null?expiry:Math.min(expiry,expiresAt);
}
setGatewayTls({pemFiles:metadata.pemFiles,expiresAt:expiresAt===null?null:new Date(expiresAt).toISOString(),profiles:metadata.pemFiles.map(path=>path.includes('/host-')?'host':'instance'),unavailable:[]});
await import('./main.ts');

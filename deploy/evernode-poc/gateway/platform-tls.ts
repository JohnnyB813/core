import {readFile,writeFile,stat,mkdir,chmod,chown,rename,unlink} from 'node:fs/promises';
import {X509Certificate,createPrivateKey,randomUUID} from 'node:crypto';
import {createSecureContext} from 'node:tls';
export type CertificateProfile={name:'host'|'instance';certificate:string;privateKey:string};
export type GatewayTls={pemFiles:string[];expiresAt:string|null;profiles:string[];unavailable:string[]};
const profiles:CertificateProfile[]=[
  {name:'host',certificate:'/contract/cfg/tlscert.pem',privateKey:'/contract/cfg/tlskey.pem'},
  {name:'instance',certificate:'/contract/tls/fullchain.pem',privateKey:'/contract/tls/privkey.pem'}
];
let startupTls:GatewayTls={pemFiles:[],expiresAt:null,profiles:[],unavailable:[]};
export function gatewayTls():GatewayTls{return startupTls;}
export function setGatewayTls(state:GatewayTls):void{startupTls=state;}
// The platform files are read, never modified. Private PEM data is staged only
// inside the container's ephemeral /run/poc directory, mode 0600, owned by the
// unprivileged runtime. No certificate or key contents enter logs or status.
export async function stagePlatformTls(selected=profiles,now=Date.now()):Promise<GatewayTls>{
  const result:GatewayTls={pemFiles:[],expiresAt:null,profiles:[],unavailable:[]};
  await mkdir('/run/poc',{recursive:true});
  for(const profile of selected){
    let temporary:string|undefined;
    try{
      const sizes=await Promise.all([stat(profile.certificate),stat(profile.privateKey)]);
      if(sizes.some(s=>!s.isFile()||s.size>65536||s.size===0))throw new Error('invalid-profile');
      const [certificate,key]=await Promise.all([readFile(profile.certificate),readFile(profile.privateKey)]);
      const leaf=new X509Certificate(certificate);
      const expiry=Date.parse(leaf.validTo),start=Date.parse(leaf.validFrom);
      if(!Number.isFinite(expiry)||!Number.isFinite(start)||start>now||expiry<now+2*60*60*1000)throw new Error('invalid-profile');
      if(!leaf.checkPrivateKey(createPrivateKey(key)))throw new Error('invalid-profile');
      createSecureContext({cert:certificate,key,minVersion:'TLSv1.2'});
      const destination='/run/poc/'+profile.name+'-tls.pem';
      temporary=destination+'.'+randomUUID()+'.next';
      await writeFile(temporary,Buffer.concat([certificate,Buffer.from('\n'),key,Buffer.from('\n')]),{mode:0o600,flag:'wx'});
      await chmod(temporary,0o600);
      if(process.getuid?.()===0)await chown(temporary,1000,1000);
      await rename(temporary,destination);temporary=undefined;
      result.pemFiles.push(destination);result.profiles.push(profile.name);
      if(result.expiresAt===null||expiry<Date.parse(result.expiresAt))result.expiresAt=new Date(expiry).toISOString();
    }catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      result.unavailable.push(profile.name+':'+(code==='ENOENT'?'missing':code==='EACCES'?'unreadable':'invalid'));
    }finally{if(temporary)await unlink(temporary).catch(()=>{});}
  }
  return result;
}

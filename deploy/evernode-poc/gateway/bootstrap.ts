import {stagePlatformTls,setGatewayTls} from './platform-tls.ts';
const tls=await stagePlatformTls();
setGatewayTls(tls);
// Rootless Evernode containers expose platform certificate files to container
// root. Use that access only during bootstrap, then permanently drop identity
// before starting either the HTTP agent or HAProxy.
if(process.getuid?.()===0){process.setgroups!([]);process.setgid!(1000);process.setuid!(1000);}
if(process.getuid?.()!==1000)throw new Error('Gateway requires its unprivileged runtime identity');
console.log(JSON.stringify({event:'gateway-tls-bootstrap',enabled:tls.pemFiles.length>0,profiles:tls.profiles,expiresAt:tls.expiresAt,unavailable:tls.unavailable,uid:process.getuid()}));
await import('./main.ts');

import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {deflateRawSync} from 'node:zlib';

export type ControllerMember={id:string;domain:string;ip:string;peerPort:number;userPort:number;serverKey:string;lease:string};
export function controllerMembers(input:ControllerMember[]):ControllerMember[]{
  if(input.length!==5)throw new Error('Five controller allocations are required');
  const members=input.map(value=>{
    if(Object.keys(value).sort().join(',')!=='domain,id,ip,lease,peerPort,serverKey,userPort'||!/^c[1-5]$/.test(value.id)||!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value.domain)||isIP(value.ip)!==4||!/^ed[0-9a-f]{64}$/i.test(value.serverKey)||!(/^[A-F0-9]{64}$/).test(value.lease)||[value.peerPort,value.userPort].some(port=>!Number.isInteger(port)||port<1||port>65535)||value.peerPort===value.userPort)throw new Error('Invalid named controller allocation');
    return{...value};
  }).sort((a,b)=>a.id.localeCompare(b.id,'en'));
  for(const key of ['id','domain','ip','serverKey','lease'] as const)if(new Set(members.map(m=>m[key])).size!==5)throw new Error('Controller identities and IPs must be distinct');
  return members;
}
export function initialControllerConfig(primary?:ControllerMember){
  return{contract:{consensus:{mode:'public',roundtime:6000,threshold:80,fallback:{execute:false}},...(primary?{unl:[primary.serverKey]}:{})},mesh:{peer_discovery:{enabled:false},...(primary?{known_peers:[primary.domain+':'+primary.peerPort]}:{})}};
}

function crc32(data:Buffer):number{
  let crc=0xffffffff;
  for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return(crc^0xffffffff)>>>0;
}
// Only owned, fixed names enter this small deterministic archive. No recursive
// filesystem collection, paths from a host, install scripts or secret files.
function zip(entries:{name:string;content:Buffer}[]):Buffer{
  const records:Buffer[]=[],directory:Buffer[]=[];let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name),packed=deflateRawSync(entry.content,{level:9}),crc=crc32(entry.content);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(0x21,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(entry.content.length,22);header.writeUInt16LE(name.length,26);
    records.push(header,name,packed);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(0x314,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(8,10);central.writeUInt16LE(0x21,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(entry.content.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE((0o100644<<16)>>>0,38);central.writeUInt32LE(offset,42);directory.push(central,name);
    offset+=header.length+name.length+packed.length;
  }
  const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...records,central,end]);
}
export function controllerBundle(contract:Buffer,allocations:ControllerMember[]){
  const members=controllerMembers(allocations);
  if(contract.length<1||contract.length>131072)throw new Error('Invalid owned contract bundle size');
  const configuration={contract:{bin_path:'/usr/bin/node',bin_args:'contract.cjs',version:'warthog-pilot-v1',unl:members.map(m=>m.serverKey),consensus:{mode:'public',roundtime:2000,threshold:80,fallback:{execute:false}},max_input_ledger_offset:10,round_limits:{user_input_bytes:131072,user_output_bytes:65536,proc_cpu_seconds:2}},mesh:{known_peers:members.map(m=>m.domain+':'+m.peerPort)}};
  const entries=[{name:'contract.cjs',content:contract},{name:'hp.cfg.override',content:Buffer.from(JSON.stringify(configuration))}];
  const archive=zip(entries);
  if(archive.length>131072)throw new Error('Controller upload exceeds its input byte cap');
  return{archive,sha256:createHash('sha256').update(archive).digest('hex'),members,configuration,files:entries.map(e=>({name:e.name,bytes:e.content.length,sha256:createHash('sha256').update(e.content).digest('hex')}))};
}

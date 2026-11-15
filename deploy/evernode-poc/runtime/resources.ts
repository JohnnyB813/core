import {readFile,stat,statfs} from 'node:fs/promises';
type Reader=(path:string)=>Promise<string|null>;
const read:Reader=async path=>{try{return(await readFile(path,'utf8')).trim();}catch{return null;}};
const numeric=(value:string|null):number|null=>value!==null&&/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
export async function cgroupResources(reader:Reader=read){
  const memoryV2=await reader('/sys/fs/cgroup/memory.max');
  const memoryV1=memoryV2===null?await reader('/sys/fs/cgroup/memory/memory.limit_in_bytes'):null;
  const memoryText=memoryV2??memoryV1,memoryNumber=numeric(memoryText);
  const memoryLimitKind=memoryText==='max'||memoryV1!==null&&Number(memoryV1)>=2**60?'unlimited':memoryNumber!==null?'limited':'unavailable';
  const memoryLimitBytes=memoryLimitKind==='limited'?memoryNumber:null;
  const memoryCurrentBytes=numeric(await reader(memoryV2!==null?'/sys/fs/cgroup/memory.current':'/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  const memoryPeakBytes=numeric(await reader(memoryV2!==null?'/sys/fs/cgroup/memory.peak':'/sys/fs/cgroup/memory/memory.max_usage_in_bytes'));
  const cpuV2=await reader('/sys/fs/cgroup/cpu.max');
  let cpuCores:number|null=null,cpuLimitKind:'limited'|'unlimited'|'unavailable'='unavailable';
  if(cpuV2!==null){const [quota,period]=cpuV2.split(/\s+/);if(quota==='max')cpuLimitKind='unlimited';else if(numeric(quota)!==null&&numeric(period)!==null&&Number(period)>0){cpuCores=Number(quota)/Number(period);cpuLimitKind='limited';}}
  else for(const group of ['cpu','cpu,cpuacct']){
    const quota=await reader('/sys/fs/cgroup/'+group+'/cpu.cfs_quota_us'),period=numeric(await reader('/sys/fs/cgroup/'+group+'/cpu.cfs_period_us'));
    if(quota==='-1'){cpuLimitKind='unlimited';break;}
    if(numeric(quota)!==null&&period!==null&&period>0){cpuCores=Number(quota)/period;cpuLimitKind='limited';break;}
  }
  return{memoryCurrentBytes,memoryPeakBytes,memoryLimitBytes,memoryLimitKind,cpuCores,cpuLimitKind};
}
export async function resources(dataDirectory:string){
  const limits=await cgroupResources();
  let ownedDatabaseBytes=0;
  for(const name of ['chain.db3','chain.db3-wal','chain.db3-shm','peers.db3','peers.db3-wal','peers.db3-shm'])try{ownedDatabaseBytes+=(await stat(dataDirectory+'/'+name)).size;}catch{}
  const quota=process.env.DISK_QUOTA_BYTES;
  // This environment value is not proof of either its units or an enforced
  // tenant quota. Keep it separate from measured filesystem availability.
  const hostDiskQuotaValue=numeric(quota??null);
  let filesystem:{availableBytes:number;totalBytes:number;scope:string}|null=null;
  try{const value=await statfs(dataDirectory);const availableBytes=value.bavail*value.bsize,totalBytes=value.blocks*value.bsize;if(Number.isSafeInteger(availableBytes)&&Number.isSafeInteger(totalBytes))filesystem={availableBytes,totalBytes,scope:'underlying-filesystem-not-proven-tenant-quota'};}catch{}
  const volumeId=await read(dataDirectory+'/.evernode-volume-id'),starts=numeric(await read(dataDirectory+'/.evernode-start-count'));
  return{...limits,hostDiskQuotaValue,quotaBytesVerified:false,ownedDatabaseBytes,filesystem,volumeId:volumeId&&/^[a-f0-9-]{36}$/.test(volumeId)?volumeId:null,starts};
}

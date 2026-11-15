import {readFile,stat} from 'node:fs/promises';
async function numberFile(path:string):Promise<number|null>{try{const value=(await readFile(path,'utf8')).trim();return /^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;}catch{return null;}}
export async function resources(dataDirectory:string){
  const [memoryCurrentBytes,memoryPeakBytes,memoryLimitBytes]=await Promise.all(['memory.current','memory.peak','memory.max'].map(name=>numberFile('/sys/fs/cgroup/'+name)));
  let cpuCores:number|null=null;
  try{const [quota,period]=(await readFile('/sys/fs/cgroup/cpu.max','utf8')).trim().split(/\s+/).map(Number);if(Number.isFinite(quota)&&Number.isFinite(period)&&period>0)cpuCores=quota/period;}catch{}
  let ownedDatabaseBytes=0;
  for(const name of ['chain.db3','chain.db3-wal','chain.db3-shm','peers.db3','peers.db3-wal','peers.db3-shm'])try{ownedDatabaseBytes+=(await stat(dataDirectory+'/'+name)).size;}catch{}
  const quota=process.env.DISK_QUOTA_BYTES;
  const diskQuotaBytes=quota&&/^\d+$/.test(quota)&&Number.isSafeInteger(Number(quota))?Number(quota):null;
  return{memoryCurrentBytes,memoryPeakBytes,memoryLimitBytes,cpuCores,diskQuotaBytes,ownedDatabaseBytes,quotaSource:diskQuotaBytes===null?'unavailable':'host-allocation-environment'};
}

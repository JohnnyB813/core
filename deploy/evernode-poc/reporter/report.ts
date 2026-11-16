import type {PoolSample,PoolEndpoint} from '../shared/pool-probe.ts';
import type {WorkerReport} from '../controller/reducer.ts';
export type HealthReport={type:'health-report';sequence:number;observedAt:number;workers:WorkerReport[]};
export function makeReport(sequence:number,now:number,backends:PoolEndpoint[],samples:Map<string,PoolSample>):HealthReport{
  if(!Number.isSafeInteger(sequence)||sequence<0||!Number.isSafeInteger(now)||now<0||backends.length!==3||new Set(backends.map(b=>b.id)).size!==3)throw new Error('Invalid report context');
  let observedAt=now;
  const workers=backends.map(backend=>{
    const observation=samples.get(backend.id)?.observation;
    // Raw semantic evidence goes to the controller; a network failure is never
    // converted into a successful sample or omitted from the fixed worker set.
    if(!observation||observation.observedAt>now||now-observation.observedAt>30000)return{id:backend.id,reachable:false};
    observedAt=Math.min(observedAt,observation.observedAt);
    return{id:backend.id,reachable:true,head:observation.head,peers:observation.peers,checkpointHash:observation.checkpointHash,latencyMs:observation.latencyMs,...(observation.common?{common:observation.common}:{})};
  }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  return{type:'health-report',sequence,observedAt,workers};
}

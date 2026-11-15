import {probe} from './probe.ts';
import {boundedJson,endpoint} from './http.ts';
import {assess,parseHash} from './health.ts';
import type {Observation,Assessment,Policy,Checkpoint} from './health.ts';
export type PoolEndpoint={id:string;url:string};
export type PoolObservation=Observation&{common?:Checkpoint};
export type PoolSample={observation?:PoolObservation;assessment:Assessment};
// All network work stays outside the deterministic controller. A slow third
// worker cannot consume the two good workers' individual latency budgets.
export async function probePool(backends:PoolEndpoint[],policy:Policy,requestedHeight?:number,timeoutMs=3000):Promise<Map<string,PoolSample>>{
  if(backends.length!==3)throw new Error('The pilot consistency check requires three workers');
  const samples=new Map<string,PoolSample>();
  await Promise.all(backends.map(async backend=>{try{const observation=await probe(backend.url,policy.checkpoint,timeoutMs);samples.set(backend.id,{observation,assessment:assess(observation,observation.head.height,Date.now(),policy)});}catch{samples.set(backend.id,{assessment:{healthy:false,reason:'probe-failed'}});}}));
  const good=backends.filter(b=>samples.get(b.id)?.assessment.healthy).sort((a,b)=>samples.get(b.id)!.observation!.head.height-samples.get(a.id)!.observation!.head.height);
  if(good.length<2){for(const b of good)samples.get(b.id)!.assessment={healthy:false,reason:'no-worker-majority'};return samples;}
  const height=good[1]&&Math.max(policy.checkpoint.height,samples.get(good[1].id)!.observation!.head.height-10);
  const hashes=new Map<string,{hash:string;latencyMs:number}>();
  const reportHeight=requestedHeight??height;
  const heights=[...new Set([height,reportHeight])];
  await Promise.all(good.flatMap(b=>heights.map(async h=>{
    const observation=samples.get(b.id)!.observation!;
    if(observation.head.height<h+10)return;
    const began=performance.now();
    try{const hash=parseHash(await boundedJson(endpoint(b.url).origin+'/chain/block/'+h+'/hash',timeoutMs));hashes.set(b.id+':'+h,{hash,latencyMs:performance.now()-began});}catch{}
  })));
  const pairs:{height:number;hash:string}[]=[];
  for(let i=0;i<good.length;i++)for(let j=i+1;j<good.length;j++){
    const a=samples.get(good[i].id)!.observation!,b=samples.get(good[j].id)!.observation!;
    const ah=hashes.get(good[i].id+':'+height),bh=hashes.get(good[j].id+':'+height);
    if(ah&&bh&&ah.hash===bh.hash&&Math.abs(a.head.height-b.head.height)<=policy.maxLag)pairs.push({height:Math.max(a.head.height,b.head.height),hash:ah.hash});
  }
  pairs.sort((a,b)=>b.height-a.height);const agreed=pairs[0];
  for(const backend of good){
    const sample=samples.get(backend.id)!,observation=sample.observation!;
    const dynamic=hashes.get(backend.id+':'+height),reported=hashes.get(backend.id+':'+reportHeight);
    if(reported)observation.common={height:reportHeight,hash:reported.hash};
    observation.latencyMs+=Math.max(dynamic?.latencyMs??0,reported?.latencyMs??0);
    sample.assessment=agreed&&dynamic?.hash===agreed.hash?assess(observation,agreed.height,Date.now(),policy):{healthy:false,reason:'no-worker-majority'};
  }
  return samples;
}

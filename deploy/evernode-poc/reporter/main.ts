import {readFile,stat} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {parseConfig} from '../gateway/config.ts';
import {ControllerPoller,commonReplies} from '../gateway/controllers.ts';
import {probePool} from '../shared/pool-probe.ts';
import {loadHotPocket} from '../shared/hotpocket.ts';
import identity from '../deploy/pilot-identity.json' with {type:'json'};
import {makeReport} from './report.ts';
import {reserveSequence} from './sequence.ts';
import {sendReport} from './transport.ts';
import {reporterKeys} from './identity.ts';
const configuration=process.env.PILOT_CONFIG,keyPath=process.env.REPORTER_KEY_FILE,statePath=process.env.REPORTER_SEQUENCE_FILE,id=process.env.REPORTER_ID;
if(!configuration||!keyPath||!statePath)throw new Error('Explicit pilot config, secret file and persistent sequence file are required');
const config=parseConfig(JSON.parse(await readFile(configuration,'utf8')));
if(config.contractId!==identity.contractId||config.controllerEndpoints.length!==5||config.backends.length!==3)throw new Error('Reporter requires the fixed connected pilot');
const reporter=identity.reporters.find(r=>r.id===id);
if(!reporter)throw new Error('Unknown reporter role');
if((await stat(keyPath)).size>256)throw new Error('Invalid reporter secret file');
const secret=(await readFile(keyPath,'utf8')).trim();
const hp=loadHotPocket(),keys=await reporterKeys(secret,reporter.publicKey),poller=new ControllerPoller(config.contractId,config.controllerEndpoints);
const abort=new AbortController();
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{abort.abort();void poller.close();});
while(!abort.signal.aborted){
  const began=Date.now();
  try{
    const replies=commonReplies(await poller.poll(),config.contractId,Date.now());
    const snapshot=replies[0]?.snapshot;
    if(!snapshot||!snapshot.probeHeight||snapshot.probeHeight<config.policy.checkpoint.height)throw new Error('Controller quorum unavailable');
    const samples=await probePool(config.backends,config.policy,snapshot.probeHeight);
    if(abort.signal.aborted)break;
    const sequence=await reserveSequence(statePath,Date.now());
    const report=makeReport(sequence,Date.now(),config.backends,samples),body=JSON.stringify(report);
    let accepted=false;
    // Stable rotation distributes submissions; only current quorum identities
    // are tried. Equal-sequence retries carry identical report bodies.
    const endpoints=config.controllerEndpoints.filter(c=>replies.some(r=>r.controllerId===c.id));
    const start=sequence%endpoints.length;
    for(let i=0;i<endpoints.length&&!abort.signal.aborted;i++){
      if(Date.now()-report.observedAt>20000)break;
      if(await sendReport(hp,keys,config.contractId,endpoints[(start+i)%endpoints.length],body,sequence)){accepted=true;break;}
    }
    console.log(JSON.stringify({event:'health-report',reporter:id,sequence,accepted,workersObserved:report.workers.filter(w=>w.reachable).length}));
  }catch{console.log(JSON.stringify({event:'reporter-not-ready',reporter:id}));}
  await delay(Math.max(1,10000-(Date.now()-began)),undefined,{signal:abort.signal}).catch(()=>{});
}
await poller.close();

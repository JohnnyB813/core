import {mkdir,chown,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {stagePlatformTls} from '../gateway/platform-tls.ts';
import {FaultController} from '../fault/controller.ts';
import {FileControlStore} from '../fault/store.ts';
import {SetupInstaller} from '../fault/setup.ts';
import {ConfigUpdater} from '../fault/config-update.ts';
import {startControlServer} from '../fault/server.ts';
import {ManagedProcess} from './process.ts';
import {resources} from './resources.ts';
import {workerApi} from './worker-api.ts';
import {EgressObservation} from './egress.ts';
import identity from '../deploy/pilot-identity.json' with {type:'json'};
import operator from '../deploy/fault-operator.json' with {type:'json'};

const role=process.env.ROLE||'',mode=process.env.PILOT_RUNTIME||'';
const validRole=mode==='worker'?/^w[1-3]$/.test(role):mode==='gateway'?/^g[12]$/.test(role):mode==='controller'?/^c[1-5]$/.test(role):false;
if(!validRole||operator.contractId!==identity.contractId)throw new Error('An explicit matching pilot runtime role is required');
if(process.platform!=='linux')throw new Error('The pilot runtime requires Linux');
function allocatedPort(name:string):number{const text=process.env[name]||'';if(!/^[1-9][0-9]{0,4}$/.test(text)||Number(text)>65535)throw new Error('A valid allocated '+name+' is required');return Number(text);}
const controlPort=allocatedPort(mode==='gateway'?'INTERNAL_USER_PORT':'INTERNAL_GPTCP1_PORT');
const dataDirectory=mode==='worker'?'/warthog/.warthog':'/pilotdata';
const controllerArguments=process.argv.slice(2);
if(mode==='controller'&&controllerArguments.length&&!(controllerArguments[0]==='run'&&controllerArguments[1]==='/contract'))throw new Error('Unexpected controller runtime arguments');
const stateDirectory=dataDirectory+(mode==='worker'?'/pilot':'');
await mkdir(dataDirectory,{recursive:true,mode:0o700});await mkdir(stateDirectory,{recursive:true,mode:0o700});await mkdir('/run/poc',{recursive:true});
const tls=await stagePlatformTls();
if(!tls.pemFiles.length)throw new Error('A valid platform certificate is required for pilot setup and controls');
await writeFile('/run/poc/tls-meta.json',JSON.stringify({pemFiles:tls.pemFiles})+'\n',{mode:0o600});
if(mode!=='controller'&&process.getuid?.()===0){
  for(const path of [dataDirectory,stateDirectory,'/run/poc','/run/poc/tls-meta.json'])await chown(path,1000,1000);
  process.setgroups!([]);process.setgid!(1000);process.setuid!(1000);
}
if(mode!=='controller'&&process.getuid?.()!==1000)throw new Error('Worker and gateway runtimes require UID 1000');
let application:ManagedProcess|null=null,reporter:ManagedProcess|null=null,stopping=false;
let processChanges:Promise<unknown>=Promise.resolve(),appliedConfigHash:string|null=null,appliedRevision:number|null=null;
function changeApplication<T>(work:()=>Promise<T>):Promise<T>{const next=processChanges.then(work);processChanges=next.catch(()=>{});return next;}
const abort=new AbortController();
const target={pause:()=>changeApplication(async()=>{if(!application?.running)throw new Error('Pilot application is not running');await application.pause();}),resume:()=>changeApplication(async()=>{await application?.resume();})};
const controller=await FaultController.create({contractId:identity.contractId,targetId:role,operatorPublicKey:operator.operatorPublicKey},target,new FileControlStore(stateDirectory+'/controls.json'));
const reporterIdentity=identity.reporters.find(item=>item.id===role);
if(mode!=='controller'&&!reporterIdentity)throw new Error('The runtime reporter identity is missing');
const installer=reporterIdentity?new SetupInstaller({contractId:identity.contractId,targetId:role,generation:()=>controller.status().generation,operatorPublicKey:operator.operatorPublicKey,reporterPublicKey:reporterIdentity.publicKey,directory:stateDirectory+'/setup'}):undefined;
const updater=installer?new ConfigUpdater({contractId:identity.contractId,targetId:role,generation:()=>controller.status().generation,operatorPublicKey:operator.operatorPublicKey,directory:stateDirectory+'/config-updates',initialFile:stateDirectory+'/setup/config.json',initialHash:async()=>{const status=await installer.status();if(!status.installed)throw new Error('Initial setup is unavailable');return status.receipt.configHash;},paused:()=>controller.status().paused}):undefined;
const imageDigest=process.env.IMAGE_DIGEST?.replace(/^@/,'');
const readAdapter=mode==='worker'?workerApi(allocatedPort('INTERNAL_USER_PORT')):undefined;
const egress=new EgressObservation();egress.start();
const control=await startControlServer(controller,controlPort,tls.pemFiles[0],installer,async()=>({role,mode,applicationRunning:application?.running===true,reporterRunning:reporter?.running===true,imageDigest:imageDigest&&/^sha256:[a-f0-9]{64}$/.test(imageDigest)?imageDigest:null,tlsExpiresAt:tls.expiresAt,network:egress.current(),configuration:{revision:appliedRevision,configHash:appliedConfigHash},resources:await resources(dataDirectory)}),readAdapter,updater);
async function startApplication(configuration?:string):Promise<ManagedProcess>{
  const environment={...process.env};
  let created:ManagedProcess;
  if(mode==='gateway'){
    if(configuration)environment.PILOT_CONFIG=configuration;else delete environment.PILOT_CONFIG;
    created=await ManagedProcess.launch(process.execPath,['/app/gateway/supervised.ts'],environment);
  }else if(mode==='worker')created=await ManagedProcess.launch('/app/worker/entrypoint.sh',[],environment);
  else created=await ManagedProcess.launch('/usr/local/bin/hotpocket/hpcore',controllerArguments.length?controllerArguments:['run','/contract'],environment);
  if(stopping){await created.stop();throw new Error('Runtime is stopping');}
  return created;
}
async function stop(){
  if(stopping)return;stopping=true;abort.abort();
  egress.stop();
  await control.close().catch(()=>{});await reporter?.stop().catch(()=>{});await application?.stop().catch(()=>{});
}
process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
process.once('uncaughtException',()=>{console.error(JSON.stringify({event:'runtime-failed',role}));process.exitCode=1;void stop();});
process.once('unhandledRejection',()=>{console.error(JSON.stringify({event:'runtime-failed',role}));process.exitCode=1;void stop();});
try{
  const existing=await installer?.status();
  const initial=existing?.installed?await updater!.current():undefined;
  application=await startApplication(initial?.path);appliedConfigHash=initial?.configHash??null;appliedRevision=initial?.revision??null;
  console.log(JSON.stringify({event:'pilot-runtime-start',role,mode,uid:process.getuid?.(),controlPort,setupInstalled:existing?.installed===true,tlsExpiresAt:tls.expiresAt}));
  if(installer&&updater){
    while(!stopping){
      if((await installer.status()).installed){
        const current=await updater.current();
        if((!reporter||current.configHash!==appliedConfigHash)&&!controller.status().paused){
          await reporter?.stop();reporter=null;if(stopping)break;
          if(mode==='gateway'&&current.configHash!==appliedConfigHash)await changeApplication(async()=>{await application!.stop();if(stopping)return;application=await startApplication(current.path);if(controller.status().paused)await application.pause();});
          if(stopping)break;
          reporter=await ManagedProcess.launch(process.execPath,['/app/reporter/main.ts'],{...process.env,PILOT_CONFIG:current.path,REPORTER_ID:role,REPORTER_KEY_FILE:stateDirectory+'/setup/reporter.key',REPORTER_SEQUENCE_FILE:stateDirectory+'/reporter-sequence.json'});
          if(stopping){await reporter.stop();break;}
          appliedConfigHash=current.configHash;appliedRevision=current.revision;
          console.log(JSON.stringify({event:'runtime-reporter-start',role,configurationRevision:current.revision}));
        }
      }
      await delay(1000,undefined,{signal:abort.signal}).catch(()=>{});
    }
  }
}catch{console.error(JSON.stringify({event:'runtime-start-failed',role}));process.exitCode=1;await stop();}

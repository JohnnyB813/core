import HotPocket from 'hotpocket-nodejs-contract';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {executeContract} from './contract.ts';
import type {PoolState} from './reducer.ts';
import {pilotConfig} from './pilot-config.ts';
if(pilotConfig.reporters.length!==5||pilotConfig.reporters.some(key=>!/^ed[0-9a-f]{64}$/i.test(key)))throw new Error('Five explicit reporter public keys are required');
const store={
  load:async():Promise<PoolState|null>=>{try{return JSON.parse(await readFile('pool-state.json','utf8')) as PoolState;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}},
  save:async(state:PoolState):Promise<void>=>{await writeFile('pool-state.json.next',JSON.stringify(state));await rename('pool-state.json.next','pool-state.json');}
};
new HotPocket.Contract().init(ctx=>executeContract(ctx,pilotConfig,store));

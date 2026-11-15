import identity from '../deploy/pilot-identity.json' with {type:'json'};
import policy from '../shared/mainnet-policy.json' with {type:'json'};
import type {ControllerConfig} from './reducer.ts';
export const pilotConfig:ControllerConfig={contractId:identity.contractId,workers:['w1','w2','w3'],reporters:identity.reporters.map(r=>r.publicKey),policy};

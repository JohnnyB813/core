import {loadHotPocket} from '../shared/hotpocket.ts';
const hp=loadHotPocket();
hp.setLogLevel(-1);
const client=await hp.createClient([process.argv[2]],await hp.generateKeys(),{contractId:'fixture',trustedServerKeys:['ed'+'01'.repeat(32)],requiredConnectionCount:1,connectionTimeoutMs:1000});
try{if(await client.connect())throw new Error('Invalid fixture must not complete HotPocket authentication');}finally{await client.close();}

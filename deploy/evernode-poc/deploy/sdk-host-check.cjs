// Read-only mainnet SDK compatibility check. No seed, token, signing, or submission.
const fs=require('node:fs');
const {Defaults,TenantClient,XrplApi,EvernodeHelpers,TransactionHelper,EventTypes,TenantEvents}=require('evernode-js-client');
const config=JSON.parse(fs.readFileSync(process.argv[2]||'.local/operator-trial.json','utf8'));
const {account,hostAddress,extensionHash,minimumLedger}=config.operator;
const output={checkedAt:new Date().toISOString(),sdkVersion:'0.6.61',mode:'read-only-no-secret',account,hostAddress};
let api,tenant;
const timeout=setTimeout(()=>{console.error('Read-only SDK check exceeded 30 seconds');process.exit(2);},30000);
(async()=>{
 try {
  await Defaults.useNetwork('mainnet');
  api=new XrplApi('wss://xahau.network',{autoReconnect:false,fallbackRippledServers:[],xrplClientOptions:{connectionTimeout:10000,timeout:10000}});
  tenant=new TenantClient(account,null,{xrplApi:api});
  for(const method of ['prepareAccount','acquireLease','acquireLeaseSubmit','extendLease','extendLeaseSubmit','terminateLease'])tenant[method]=()=>{throw new Error('Writes are disabled in this compatibility check');};
  await tenant.connect();
  const host=await tenant.getLeaseHost(hostAddress);
  const [info,offers]=await Promise.all([tenant.getHostInfo(hostAddress),EvernodeHelpers.getLeaseOffers(host)]);
  output.host={address:host.address,active:info.active,domain:info.domain,version:info.version,maxInstances:info.maxInstances,activeInstances:info.activeInstances,offeredLeaseCount:offers.length,offerAmounts:offers.map(x=>x.Amount).filter(Boolean)};
  const transactions=await tenant.xrplAcc.getAccountTrx(minimumLedger);
  const extendTypes=Object.values(EventTypes).filter(v=>typeof v==='string'&&/extend.*success/i.test(v));
  for(const envelope of transactions){
   const tx=envelope.tx||envelope.tx_json;
   if(tx?.Account!==hostAddress||tx?.Destination!==account)continue;
   const isExtension=(tx.HookParameters||[]).some(p=>extendTypes.includes(Buffer.from(p.HookParameter?.HookParameterValue||'','hex').toString('utf8')));
   if(!isExtension)continue;
   tx.Memos=TransactionHelper.deserializeMemos(tx.Memos);
   tx.HookParameters=TransactionHelper.deserializeHookParams(tx.HookParameters);
   const event=await tenant.extractEvernodeEvent(tx);
   if(event?.name===TenantEvents.ExtendSuccess&&event.data?.extendRefId===extensionHash)output.confirmedExtension={extendRefId:event.data.extendRefId,expiryMoment:event.data.expiryMoment};
  }
  output.success=true;
 }catch(error){output.success=false;output.error=error instanceof Error?error.message:JSON.stringify(error);process.exitCode=1;}
 finally{if(tenant)await tenant.disconnect().catch(()=>{});if(api)await api.disconnect().catch(()=>{});clearTimeout(timeout);fs.mkdirSync('evidence',{recursive:true});fs.writeFileSync('evidence/sdk-host-check-latest.json',JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));}
})();

declare module 'hotpocket-nodejs-contract' {
  const HotPocket:{Contract:new()=>{init:(contract:(ctx:import('../controller/contract.ts').ContractContext)=>Promise<void>)=>Promise<boolean>}};
  export default HotPocket;
}

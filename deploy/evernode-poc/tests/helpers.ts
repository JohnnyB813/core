import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse,Server} from 'node:http';
export async function fixture(handler:(req:IncomingMessage,res:ServerResponse)=>void):Promise<{server:Server;url:string;close:()=>Promise<void>}> {
  const server=createServer(handler);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  if(!address || typeof address==='string')throw new Error('No fixture address');
  return {server,url:'http://127.0.0.1:'+address.port,close:()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})};
}
export const hash='a'.repeat(64);
export const head={code:0,data:{height:5000100,hash,synced:true}};

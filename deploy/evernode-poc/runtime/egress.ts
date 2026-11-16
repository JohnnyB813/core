import {isIP} from 'node:net';
type Fetcher=(input:string,init:RequestInit)=>Promise<Response>;
export class EgressObservation{
  #state:{status:'pending'|'observed'|'unavailable';ip:string|null;checkedAt:number|null;source:string}={status:'pending',ip:null,checkedAt:null,source:'https://api.ipify.org'};
  #attempts=0;#pending:Promise<void>|null=null;#timer:NodeJS.Timeout|undefined;#closed=false;
  current(){return{...this.#state};}
  async check(fetcher:Fetcher=fetch,now:()=>number=Date.now):Promise<void>{
    if(this.#closed||this.#state.status==='observed'||this.#attempts>=3)return;
    if(this.#pending)return this.#pending;
    this.#attempts++;
    this.#pending=(async()=>{
      try{
        const response=await fetcher('https://api.ipify.org?format=json',{signal:AbortSignal.timeout(1500),redirect:'error',headers:{accept:'application/json'}});
        if(!response.ok||!response.body)throw new Error('Egress observation unavailable');
        let bytes=0;const chunks:Uint8Array[]=[];
        for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>1024){await response.body.cancel().catch(()=>{});throw new Error('Invalid egress response');}chunks.push(chunk);}
        const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(Object.keys(value).join(',')!=='ip'||typeof value.ip!=='string'||isIP(value.ip)!==4)throw new Error('Invalid IPv4 egress observation');
        this.#state={...this.#state,status:'observed',ip:value.ip,checkedAt:now()};
      }catch{this.#state={...this.#state,status:'unavailable',ip:null,checkedAt:now()};}
      finally{this.#pending=null;}
    })();return this.#pending;
  }
  start(){const attempt=async()=>{await this.check();if(!this.#closed&&this.#state.status!=='observed'&&this.#attempts<3){this.#timer=setTimeout(()=>{void attempt();},60000);this.#timer.unref();}};void attempt();}
  stop(){this.#closed=true;clearTimeout(this.#timer);}
}

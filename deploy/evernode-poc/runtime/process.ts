import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
export class ManagedProcess {
  #child:ChildProcess;#birth:string;#exit:Promise<void>;
  private constructor(child:ChildProcess,birth:string,exit:Promise<void>){this.#child=child;this.#birth=birth;this.#exit=exit;}
  static async launch(command:string,args:string[],environment:NodeJS.ProcessEnv):Promise<ManagedProcess>{
    if(process.platform!=='linux')throw new Error('Pilot process groups require Linux');
    const child=spawn(command,args,{env:environment,detached:true,stdio:'inherit'});
    const exit=new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.once('error',()=>resolve());});
    await once(child,'spawn');
    if(!child.pid)throw new Error('Pilot process did not start');
    const fields=await ManagedProcess.#identity(child.pid);
    if(fields.group!==child.pid)throw new Error('Pilot process group differs');
    return new ManagedProcess(child,fields.birth,exit);
  }
  static async #identity(pid:number):Promise<{group:number;birth:string}>{
    const line=await readFile('/proc/'+pid+'/stat','utf8'),end=line.lastIndexOf(') '),fields=line.slice(end+2).trim().split(/\s+/);
    if(end<0||fields.length<20)throw new Error('Pilot process identity is unavailable');
    return{group:Number(fields[2]),birth:fields[19]};
  }
  get running():boolean{return this.#child.exitCode===null&&this.#child.signalCode===null;}
  async #signal(signal:NodeJS.Signals):Promise<void>{
    const pid=this.#child.pid;if(!pid||!this.running)throw new Error('Pilot process is not running');
    const current=await ManagedProcess.#identity(pid);if(current.group!==pid||current.birth!==this.#birth)throw new Error('Pilot process identity changed');
    process.kill(-pid,signal);
  }
  async pause(){await this.#signal('SIGSTOP');}
  async resume(){if(this.running)await this.#signal('SIGCONT');}
  async stop(){
    if(!this.running)return;await this.resume();await this.#signal('SIGTERM');
    const timer=new AbortController();
    let stopped:boolean;try{stopped=await Promise.race([this.#exit.then(()=>true),delay(10000,false,{signal:timer.signal})]);}finally{timer.abort();}
    if(!stopped){await this.#signal('SIGKILL');await this.#exit;}
  }
}

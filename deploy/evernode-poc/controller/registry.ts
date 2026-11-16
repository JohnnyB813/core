import {createHash} from 'node:crypto';
export type Snapshot = {contractId:string; sequence:number; committedAt:number; eligible:string[];probeHeight?:number};
// Only an adapter that validated the HotPocket server identity may construct these.
// This is an internal interface; it is never accepted from an HTTP request.
export type VerifiedControllerReply = {controllerId:string; observedAt:number; snapshot:Snapshot; stateHash:string};
export function stateHash(snapshot: Snapshot): string {
  return createHash('sha256').update(JSON.stringify({contractId:snapshot.contractId, sequence:snapshot.sequence, committedAt:snapshot.committedAt, eligible:[...snapshot.eligible].sort(),probeHeight:snapshot.probeHeight??null})).digest('hex');
}
export class RegistryGuard {
  readonly contractId: string;
  readonly controllers: Set<string>;
  readonly workers: Set<string>;
  readonly maxReplyAgeMs = 30000;
  readonly degradedWindowMs = 300000;
  last: Snapshot | null = null;
  lastQuorumAt: number | null = null;
  quorumAvailable = false;
  removedLocally = new Set<string>();
  constructor(contractId:string, controllers:string[], workers:string[]) {
    if (!contractId || new Set(controllers).size !== 5 || controllers.length !== 5 || new Set(workers).size !== workers.length) throw new Error('A fixed five-controller set and unique workers are required');
    this.contractId=contractId;this.controllers=new Set(controllers);this.workers=new Set(workers);
  }
  accept(replies: VerifiedControllerReply[], now:number): boolean {
    this.quorumAvailable = false;
    if (!Number.isFinite(now)) return false;
    const valid = new Map<string, VerifiedControllerReply>();
    const conflicted = new Set<string>();
    for (const reply of replies) {
      const s = reply.snapshot;
      if (!s || typeof s !== 'object') continue;
      if (!this.controllers.has(reply.controllerId) || conflicted.has(reply.controllerId)) continue;
      if (reply.observedAt > now || now-reply.observedAt > this.maxReplyAgeMs || !Number.isFinite(reply.observedAt)) continue;
      if (s.contractId !== this.contractId || !Number.isSafeInteger(s.sequence) || s.sequence < 0 || !Number.isFinite(s.committedAt) || s.committedAt > now || now-s.committedAt > this.maxReplyAgeMs) continue;
      if(s.probeHeight!==undefined&&(!Number.isSafeInteger(s.probeHeight)||s.probeHeight<1||s.probeHeight>0xffffffff))continue;
      if (!Array.isArray(s.eligible) || new Set(s.eligible).size !== s.eligible.length || s.eligible.some(id=>!this.workers.has(id)) || stateHash(s) !== reply.stateHash) continue;
      const previous = valid.get(reply.controllerId);
      if (previous && previous.stateHash !== reply.stateHash) {valid.delete(reply.controllerId);conflicted.add(reply.controllerId);continue;}
      valid.set(reply.controllerId, reply);
    }
    const groups = new Map<string, VerifiedControllerReply[]>();
    for (const reply of valid.values()) groups.set(reply.stateHash,[...(groups.get(reply.stateHash)||[]),reply]);
    const quorum = [...groups.values()].find(group=>group.length >= 4);
    if (!quorum) return false;
    const snapshot=quorum[0].snapshot;
    if (this.last && (snapshot.sequence < this.last.sequence || (snapshot.sequence === this.last.sequence && stateHash(snapshot) !== stateHash(this.last)))) return false;
    if (!this.last || snapshot.sequence > this.last.sequence) this.removedLocally.clear();
    this.last=structuredClone(snapshot);this.lastQuorumAt=now;this.quorumAvailable=true;
    return true;
  }
  quorumFresh(now:number): boolean {return this.quorumAvailable && this.lastQuorumAt !== null && now>=this.lastQuorumAt && now-this.lastQuorumAt<=this.maxReplyAgeMs;}
  // Local checks may revoke immediately. Only a new agreed sequence can clear a revocation.
  mayRoute(worker:string, localHealthy:boolean, now:number): boolean {
    if (!localHealthy) this.removedLocally.add(worker);
    return Boolean(localHealthy && !this.removedLocally.has(worker) && this.last?.eligible.includes(worker) && this.lastQuorumAt !== null && now>=this.lastQuorumAt && now-this.lastQuorumAt<=this.degradedWindowMs);
  }
}

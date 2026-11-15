export type Head = { height: number; hash: string; synced: boolean };
export type Checkpoint = { height: number; hash: string };
export type Observation = {
  observedAt: number;
  head: Head;
  peers: number;
  checkpointHash: string | null;
  latencyMs: number;
};
export type Policy = {
  checkpoint: Checkpoint;
  minimumHeight: number;
  maxLag: number;
  minPeers: number;
  maxLatencyMs: number;
  freshnessMs: number;
};
export type Assessment = { healthy: boolean; reason: string };
const hashPattern = /^[0-9a-f]{64}$/;
export const isHeight = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 0xffffffff;
export const isHash = (hash: unknown): hash is string => typeof hash === 'string' && hashPattern.test(hash);
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
export function apiData(body: unknown): unknown {
  const envelope = object(body);
  if (envelope.code !== 0) throw new Error('Unsuccessful API response');
  return envelope.data;
}
// This pilot pins the mainnet V1 build. A different API shape fails closed.
export function parseHead(body: unknown): Head {
  const data = object(apiData(body));
  if (!isHeight(data.height) || !isHash(data.hash) || typeof data.synced !== 'boolean') throw new Error('Invalid mainnet V1 head');
  return {height: data.height, hash: data.hash, synced: data.synced};
}
export function parseHash(body: unknown): string {
  const data = object(apiData(body));
  if (!isHash(data.hash)) throw new Error('Invalid block hash');
  return data.hash;
}
export function parsePeers(body: unknown): number {
  const data = object(apiData(body));
  const lists = Object.values(data).filter(Array.isArray);
  if (lists.length !== 1 || lists[0].length > 1000) throw new Error('Invalid peer connection list');
  return lists[0].length;
}
export function assess(observation: Observation, referenceHeight: number, now: number, policy: Policy): Assessment {
  const fail = (reason: string): Assessment => ({healthy:false, reason});
  const head = observation.head;
  if (!isHeight(head.height) || !isHash(head.hash) || typeof head.synced !== 'boolean') return fail('invalid-head');
  if (!Number.isFinite(now) || !Number.isFinite(observation.observedAt) || observation.observedAt > now || now - observation.observedAt > policy.freshnessMs) return fail('stale-observation');
  if (head.height === 0 || head.height < policy.minimumHeight || head.height < policy.checkpoint.height) return fail('below-bootstrap-floor');
  if (!head.synced) return fail('sync-incomplete');
  if (observation.checkpointHash !== policy.checkpoint.hash) return fail('checkpoint-mismatch');
  if (!isHeight(referenceHeight) || referenceHeight < policy.minimumHeight) return fail('invalid-reference');
  if (Math.abs(referenceHeight - head.height) > policy.maxLag) return fail('tip-disagreement');
  if (!Number.isSafeInteger(observation.peers) || observation.peers < policy.minPeers) return fail('insufficient-peers');
  if (!Number.isFinite(observation.latencyMs) || observation.latencyMs < 0 || observation.latencyMs > policy.maxLatencyMs) return fail('slow-response');
  return {healthy:true, reason:'healthy'};
}
export class Hysteresis {
  successes = 0;
  failures = 0;
  eligible = false;
  lastSequence = -1;
  update(sequence: number, healthy: boolean): boolean {
    if (!Number.isSafeInteger(sequence) || sequence <= this.lastSequence) throw new Error('Replayed or invalid sample sequence');
    this.lastSequence = sequence;
    if (healthy) {this.successes++; this.failures = 0; if (this.successes >= 3) this.eligible = true;}
    else {this.failures++; this.successes = 0; if (this.failures >= 3) this.eligible = false;}
    return this.eligible;
  }
}

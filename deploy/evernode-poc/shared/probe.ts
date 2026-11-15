import {boundedJson, endpoint} from './http.ts';
import {parseHead, parseHash, parsePeers} from './health.ts';
import type {Checkpoint, Observation} from './health.ts';
export async function probe(base: string, checkpoint: Checkpoint, timeoutMs = 3000): Promise<Observation> {
  const origin = endpoint(base).origin;
  const began = performance.now();
  const [head, peers] = await Promise.all([
    boundedJson(origin + '/chain/head', timeoutMs).then(parseHead),
    boundedJson(origin + '/peers/connected/connection', timeoutMs).then(parsePeers)
  ]);
  const remaining = Math.ceil(timeoutMs - (performance.now()-began));
  if (remaining <= 0) throw new Error('Probe deadline exceeded');
  const checkpointHash = head.height >= checkpoint.height
    ? parseHash(await boundedJson(origin + '/chain/block/' + checkpoint.height + '/hash', remaining)) : null;
  return {observedAt:Date.now(), head, peers, checkpointHash, latencyMs:performance.now()-began};
}

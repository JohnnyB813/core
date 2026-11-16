// Project-local patch of the locked SDK. Refuse unknown source; never change a
// global installation. Keep TLS certificate validation on, bound WS frames and
// terminate disposed Node sockets instead of waiting on an unresponsive peer.
const fs=require('node:fs');
const crypto=require('node:crypto');
const path=require.resolve('hotpocket-js-client');
const source=fs.readFileSync(path,'utf8');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const original='30cf3ccb8cbee969f601b205b383d45338b66533beb5a5a8c6292ac39d1c0e1a';
const previous='1cb1fa479e862d17983b1f0dda33e6173940f80afd9bb5ec1714bb6fd989e86c';
const patched='e9413d49d22f907de6167c0b70be13005848c9a2c25264d0fbb151317fa4d39b';
if(digest(source)===patched){console.log('Pinned HotPocket client already enforces strict TLS, bounded frames and disposed-socket cleanup.');process.exit(0);}
if(![original,previous].includes(digest(source)))throw new Error('Unexpected HotPocket client source; review the dependency before patching');
const before=digest(source)===original?'new WebSocket(server, { rejectUnauthorized: false })':'new WebSocket(server, { rejectUnauthorized: true, maxPayload: 262144 })';
const after='new WebSocket(server, { rejectUnauthorized: true, maxPayload: 262144, handshakeTimeout: connectionTimeoutMs })';
if(source.split(before).length!==2)throw new Error('Expected exactly one Node WebSocket initialization');
const closeBefore='        this.close = () => {\n            if (ws.readyState == WebSocket.OPEN) {';
const closeAfter='        this.close = () => {\n            // Node readers must release stalled handshakes and peers that never\n            // acknowledge a close frame. Browser behavior remains unchanged.\n            if (!isBrowser) {\n                ws.terminate();\n                return Promise.resolve();\n            }\n            if (ws.readyState == WebSocket.OPEN) {';
if(source.split(closeBefore).length!==2)throw new Error('Expected exactly one connection close implementation');
const updated=source.replace(before,after).replace(closeBefore,closeAfter);
if(digest(updated)!==patched)throw new Error('Unexpected patched source');
fs.writeFileSync(path,updated);
console.log('Pinned HotPocket client now enforces strict TLS, 256 KiB frames, handshake deadlines and disposed-socket cleanup.');

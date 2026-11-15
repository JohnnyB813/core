// Sashimono's acquisition schema uses owner_pubkey (not ownerpubkey).
// Reference: EvernodeXRPL/sashimono src/msg/json/msg_json.cpp extract_create_message.
export type AcquireRequirement={owner_pubkey:string;contract_id:string;image:string;config:Record<string,unknown>};
export function acquireRequirement(ownerPublicKey:string,contractId:string,image:string,config:Record<string,unknown>={}):AcquireRequirement{
 if(!/^ed[0-9a-f]{64}$/i.test(ownerPublicKey))throw new Error('Invalid HotPocket owner public key');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(contractId))throw new Error('Invalid contract identity');
 if(typeof image!=='string'||Buffer.byteLength(image)<1||Buffer.byteLength(image)>128||/[^a-zA-Z0-9_./:@=-]/.test(image))throw new Error('Invalid image and switches');
 if(!config||typeof config!=='object'||Array.isArray(config)||Object.getPrototypeOf(config)!==Object.prototype||Buffer.byteLength(JSON.stringify(config))>16384)throw new Error('Invalid initial configuration');
 return{owner_pubkey:ownerPublicKey,contract_id:contractId,image,config:JSON.parse(JSON.stringify(config)) as Record<string,unknown>};
}

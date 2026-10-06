'use strict';
const {createECDH}=require('node:crypto');

function getVapidDetails(env=process.env){
  // Derive the public half from the existing signing key. Never generate/rotate
  // a private key on requests or trust a separately copied public-key setting.
  const privateKey=String(env.VAPID_PRIVATE_KEY||'').trim();
  const bytes=Buffer.from(privateKey,'base64url');
  if(bytes.length!==32)throw Error('Push signing key unavailable');
  const pair=createECDH('prime256v1');
  pair.setPrivateKey(bytes);
  return {subject:'mailto:admin@example.com',publicKey:pair.getPublicKey().toString('base64url'),privateKey};
}
module.exports={getVapidDetails};

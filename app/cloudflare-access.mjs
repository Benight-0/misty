import {ACCESS_EMAIL} from './owner-config.mjs';
import {createPublicKey,verify} from 'node:crypto';

// The issuer and audience are administrator configuration, never taken from a JWT.
export function cloudflareAccess({issuer,audience,email=ACCESS_EMAIL,fetchImpl=fetch,clock=()=>Date.now()}){
 const url=new URL(issuer);
 if(!email||url.protocol!=='https:'||!/^[-a-z0-9]+\.cloudflareaccess\.com$/.test(url.hostname)||url.origin!==issuer||!audience)throw new Error('Invalid Cloudflare Access configuration.');
 let keys=[],expires=0,lastRefresh=0,pending;
 async function refresh(){
  if(!pending)pending=(async()=>{lastRefresh=clock();const response=await fetchImpl(issuer+'/cdn-cgi/access/certs',{signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Access certificate fetch failed');const data=await response.json();keys=(data.keys||[]).filter(k=>k.kty==='RSA'&&k.kid);expires=clock()+3600000;})().finally(()=>pending=null);
  await pending;
 }
 return async req=>{
  try{
   const token=req.headers['cf-access-jwt-assertion'];if(typeof token!=='string'||token.length>24000)return false;
   const parts=token.split('.');if(parts.length!==3)return false;
   const header=JSON.parse(Buffer.from(parts[0],'base64url')),claims=JSON.parse(Buffer.from(parts[1],'base64url'));
   if(header.alg!=='RS256'||typeof header.kid!=='string')return false;
   if(clock()>expires)await refresh();let key=keys.find(k=>k.kid===header.kid);
   if(!key&&clock()-lastRefresh>60000){await refresh();key=keys.find(k=>k.kid===header.kid);}
   if(!key)return false;
   if(!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key,format:'jwk'}),Buffer.from(parts[2],'base64url')))return false;
   const now=Math.floor(clock()/1000);
   return claims.iss===issuer&&Array.isArray(claims.aud)&&claims.aud.includes(audience)&&Number.isFinite(claims.exp)&&claims.exp>now&&Number.isFinite(claims.iat)&&claims.iat<=now+30&&(!claims.nbf||claims.nbf<=now+30)&&claims.type==='app'&&claims.email?.toLowerCase()===email.toLowerCase();
  }catch{return false;}
 };
}

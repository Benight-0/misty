// Configure verified local identities before enabling connected accounts.
const value=name=>String(process.env[name]||'').trim();
export const OWNER_DISCORD_ID=value('MISTY_OWNER_DISCORD_ID');
export const OWNER_WHATSAPP_PHONE=value('MISTY_OWNER_WHATSAPP_PHONE').replace(/^\+/,'');
export const OWNER_WHATSAPP_LID=value('MISTY_OWNER_WHATSAPP_LID');
export const OWNER_MATRIX_ID=value('MISTY_OWNER_MATRIX_ID')||'@owner:localhost';
export const ACCESS_EMAIL=value('ARCHIVAL_ACCESS_EMAIL');
export const ARCHIVE_ORIGIN=value('ARCHIVAL_PUBLIC_ORIGIN').replace(/\/$/,'');
export function safePublicSourceLink(value){
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&
 ((u.hostname==='discord.com'&&u.pathname.startsWith('/channels/'))||(ARCHIVE_ORIGIN&&u.origin===new URL(ARCHIVE_ORIGIN).origin));}catch{return false;}
}

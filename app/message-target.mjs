import {createHash} from 'node:crypto';

export const snowflake=id=>typeof id==='string'&&/^\d{16,22}$/.test(id);
export const postURL=(guild,channel,message)=>`https://discord.com/channels/${guild}/${channel}/${message}`;
// Keep private-chat targets byte-compatible with existing approved drafts.
export function messageTarget(room,verified={}){
 return {room:room.id,platform:room.platform,kind:room.kind,remoteId:room.remote_id,name:room.name,...verified};
}
export function replyId(value,channel,guild){
 if(value===undefined||value==='')return '';
 if(typeof value!=='string')throw Error('Reply reference must be a message ID, source ID or Discord message link.');
 if(snowflake(value))return value;
 let match=/^discord:(\d{16,22}):(\d{16,22})$/.exec(value);
 if(match){if(match[1]!==channel)throw Error('The reply reference belongs to another channel.');return match[2];}
 match=/^https:\/\/(?:www\.)?discord\.com\/channels\/(\d{16,22})\/(\d{16,22})\/(\d{16,22})$/.exec(value);
 if(!match||match[1]!==guild||match[2]!==channel)throw Error('The reply reference does not match the selected guild and channel.');
 return match[3];
}
export function verifiedReply(message,channel,guild,id){
 if(message?.id!==id||message.channel_id!==channel||(message.guild_id&&message.guild_id!==guild)||!snowflake(message.author?.id)||typeof message.content!=='string')throw Error('Discord did not verify the exact reply target in this channel.');
 return {messageId:id,channelId:channel,guildId:guild,authorId:message.author.id,
  authorName:String(message.author.global_name||message.author.username||message.author.id).slice(0,100),
  excerpt:message.content.slice(0,240)||'[message without text]',
  contentHash:createHash('sha256').update(JSON.stringify({content:message.content,edited:message.edited_timestamp||null})).digest('hex'),
  url:postURL(guild,channel,id)};
}
export function channelPermissions(channel,member,roles,guild,owner){
 if(!Array.isArray(roles)||!Array.isArray(member?.roles)||!Array.isArray(channel.permission_overwrites))throw Error('Discord permission metadata is unavailable.');
 const known=new Set(roles.map(r=>r.id));
 if(!known.has(guild.id)||member.roles.some(id=>!known.has(id)))throw Error('Discord role metadata is incomplete.');
 const roleIds=new Set([guild.id,...member.roles]);let permissions=0n;
 for(const role of roles)if(roleIds.has(role.id))permissions|=BigInt(role.permissions);
 if(guild.owner_id===owner||(permissions&8n))return (1n<<64n)-1n;
 for(const [ids,type] of [[new Set([guild.id]),0],[new Set(member.roles),0],[new Set([owner]),1]]){
  let allow=0n,deny=0n;
  for(const overwrite of channel.permission_overwrites)if(overwrite.type===type&&ids.has(overwrite.id)){allow|=BigInt(overwrite.allow);deny|=BigInt(overwrite.deny);}
  permissions=(permissions&~deny)|allow;
 }
 return permissions;
}

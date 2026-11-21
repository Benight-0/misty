import {OWNER_DISCORD_ID,OWNER_WHATSAPP_PHONE,OWNER_WHATSAPP_LID,OWNER_MATRIX_ID} from './owner-config.mjs';
export const OWNER=OWNER_MATRIX_ID;
export const SELF_IDENTITIES=[
 {id:OWNER,platform:'matrix',name:'You',remote:'owner',source:'Configured local account'},
 ...(OWNER_DISCORD_ID?[{id:'@discord_'+OWNER_DISCORD_ID+':localhost',platform:'discord',name:'You · Discord',remote:OWNER_DISCORD_ID,source:'Configured owner identity'}]:[]),
 ...(OWNER_WHATSAPP_PHONE?[{id:'@whatsapp_'+OWNER_WHATSAPP_PHONE+':localhost',platform:'whatsapp',name:'You · WhatsApp phone',remote:OWNER_WHATSAPP_PHONE,source:'Configured owner identity'}]:[]),
 ...(OWNER_WHATSAPP_LID?[{id:'@whatsapp_lid-'+OWNER_WHATSAPP_LID+':localhost',platform:'whatsapp',name:'You · WhatsApp',remote:OWNER_WHATSAPP_LID,source:'Configured owner identity'}]:[]),
];

export function platformOf(id = '') {
  if (id.startsWith('@discord_')) return 'discord';
  if (id.startsWith('@whatsapp_')) return 'whatsapp';
  if (id.startsWith('@instagram_') || id.startsWith('@meta_')) return 'instagram';
  if (id.startsWith('@telegram_')) return 'telegram';
  return 'matrix';
}

export function cleanBody(body = '') {
  // Reply fallbacks quote another author; do not attribute the quoted text to this sender.
  return String(body).replace(/^(?:>[^\n]*\n)+\n/, '').trim();
}

export function classifyRoom(room) {
  const bridge = room.bridge || {};
  const protocol = bridge.protocol?.id || '';
  const platform = protocol === 'discordgo' ? 'discord' : protocol || 'matrix';
  const roomType = bridge['com.beeper.room_type.v2'] || bridge['com.beeper.room_type'] || '';
  const remoteId = String(bridge.channel?.id || '');
  const serverId = String(bridge.network?.id || '');
  let kind = 'group';
  if (room.create?.type === 'm.space') kind = 'space';
  else if (roomType === 'dm') kind = 'dm';
  else if (roomType === 'group_dm') kind = 'group';
  else if (platform === 'discord' && serverId) kind = 'channel';
  else if (platform === 'whatsapp' && (remoteId.includes('@g.us') || remoteId.includes('@newsletter'))) kind = 'group';
  else if (platform === 'whatsapp' && /@(s\.whatsapp\.net|lid)/.test(remoteId)) kind = 'dm';
  const management = !protocol || /^(Discord|WhatsApp|Instagram|Telegram) bridge$/i.test(room.name || '');
  return { platform, kind, remoteId, serverId, serverName: bridge.network?.displayname || '',
    name: room.name || bridge.channel?.displayname || (kind === 'dm' ? 'Direct message' : 'Unnamed conversation'),
    management, encrypted: !!room.encrypted };
}

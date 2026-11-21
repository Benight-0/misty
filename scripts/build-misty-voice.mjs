import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {buildOwnerStyle} from '../app/misty-style.mjs';

const [archivePath,outputPath]=process.argv.slice(2);
if(!archivePath||!outputPath)throw new Error('Usage: node scripts/build-misty-voice.mjs ARCHIVE_SQLITE OUTPUT_JSON');
const db=new DatabaseSync(archivePath,{readOnly:true});
try{
 const messages=db.prepare(`SELECT m.body,m.room_id,m.ts FROM messages m JOIN conversations c ON c.id=m.room_id
  WHERE m.is_me=1 AND c.platform IN ('discord','whatsapp') AND c.include_profile=1
  ORDER BY m.ts DESC LIMIT 30000`).all().reverse();
 const profile=buildOwnerStyle(messages);
 if(profile.count<10)throw new Error('Not enough verified owner messages to build a style profile.');
 fs.writeFileSync(outputPath,JSON.stringify(profile),{mode:0o600});
 console.log(JSON.stringify({sourceMessages:messages.length,styleMessages:profile.count,examples:profile.examples.length,medianCharacters:profile.medianCharacters,capitalizedPercent:profile.capitalizedPercent,emojiPercent:profile.emojiPercent}));
}finally{db.close();}

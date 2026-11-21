import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TOPICS = [
  {id:'artificial-intelligence',name:'Artificial intelligence & machine learning',pattern:/\b(ai|artificial intelligence|machine learning|deep learning|llm|transformers?|neural|pytorch|moirai|chronos|tsfm|model training)\b/i},
  {id:'neuroscience',name:'Neuroscience & cognition',pattern:/\b(neuroscience|cognitive|cognition|neurons?|brain|language processing|emotional cognition)\b/i},
  {id:'olympiads',name:'Olympiads & competitions',pattern:/\b(ioai|ioi|usaco|usaaio|joai|olympiad|icpc|ocpc|codeforces|atcoder|competitive programming|calico|hacker cup)\b/i},
  {id:'programming',name:'Programming & building software',pattern:/\b(code|coding|programming|python|javascript|typescript|c\+\+|github|algorithm|backend|frontend|website|software|debug|api|docker|database)\b/i},
  {id:'mathematics',name:'Mathematics & problem solving',pattern:/\b(math|mathematics|mathematical|geometry|combinatorics|algebra|calculus|number theory|proof|probability|theorem)\b/i},
  {id:'research',name:'Research & scientific work',pattern:/\b(research|paper|neurips|iclr|icml|experiment|benchmark|ablation|publication|arxiv|hypothesis|workshop|conference)\b/i},
  {id:'education',name:'Learning, teaching & resources',pattern:/\b(learn|learning|teach|teaching|tutorial|curriculum|course|lecture|syllabus|guide|resources|explain|explanation|student)\b/i},
  {id:'academics',name:'School, university & applications',pattern:/\b(college|university|admission|scholarship|fellowship|school|exam|application|undergrad|sat|mit|stanford|cambridge|unsw)\b/i},
  {id:'games',name:'Games & game development',pattern:/\b(minecraft|battlecode|game|gaming|geometry dash|pokemon|pokémon|chess|smp|roblox|valorant)\b/i},
  {id:'community',name:'Community & collaboration',pattern:/\b(team|teammate|community|club|collaborat\w*|mentor|organis\w*|organiz\w*|help|together|feedback)\b/i},
  {id:'creativity',name:'Creative work & design',pattern:/\b(design|animation|drawing|artwork|music|editing|video|visual|ui|ux|creative|illustration)\b/i},
  {id:'travel',name:'Travel & exploring places',pattern:/\b(travel|travelling|traveling|countries|kazakhstan|scenery|sightseeing)\b/i},
  {id:'nature',name:'Nature & outdoor spaces',pattern:/\b(mountain|woods|forest|hiking|cabin|landscape|outdoors)\b/i},
  {id:'algorithmic-trading',name:'Algorithmic trading & backtesting',pattern:/\b(algorithmic trading|algo trading|paper trading|backtest\w*)\b/i},
  {id:'writing',name:'Poetry, stories & personal writing',pattern:/\b(poems?|poetry|poet|writing stories|write stories|writing a story|writing poem|write blogs?|my poems?|story outline)\b/i},
  {id:'reading',name:'Books & fiction',pattern:/\b(novels?|fiction|physical books|reading physically|reading book|read books|read a book)\b/i},
  {id:'music',name:'Music & guitar',pattern:/\b(music|songs?|guitar|piano|fingerpicking|finger picking|playlists?|taylor swift|bruno mars)\b/i},
  {id:'anime',name:'Anime & manga',pattern:/\b(anime|manga|naruto|haikyu|frieren|spirited away|death ?note|dr\.? stone)\b/i},
  {id:'martial-arts',name:'Taekwondo & martial arts',pattern:/\b(taekwondo|martial arts|sparring)\b/i},
  {id:'photography',name:'Photography & visual atmosphere',pattern:/\b(photograph\w*|photos?|ferris wheel|photo composition)\b/i},
];

export function scanTopics(corpus) {
  return TOPICS.map(topic=>{
    const matches=corpus.filter(m=>topic.pattern.test(m.body));
    const rooms=new Set(matches.map(m=>m.room_id));
    return {id:topic.id,title:topic.name,count:matches.length,rooms:rooms.size,
      evidence:matches.slice(-12).reverse().map(m=>m.id),examples:matches.slice(-3)};
  }).filter(topic=>topic.count>=2).sort((a,b)=>b.count-a.count);
}

export function refreshProfile(store) {
  const reviewedPath=fileURLToPath(new URL('../data/app/reviewed-profile.json',import.meta.url));
  const reviewed=fs.existsSync(reviewedPath)?JSON.parse(fs.readFileSync(reviewedPath,'utf8')):null;
  if(reviewed)store.set('profile_excluded_messages',reviewed.coverage?.excludedMessageIds||[]);
  const corpus=store.ownCorpus();
  for (const topic of scanTopics(corpus)) {
    store.saveFinding({id:'topic-'+topic.id,title:topic.title,category:'Topics you discuss',
      summary:'You discussed this topic in '+topic.count+' of your available messages across '+topic.rooms+' conversations. Mentions show participation, not necessarily endorsement or a lasting preference.',
      confidence:'observed',source:'local-topic-scan',tags:[topic.id],evidence_ids:topic.evidence});
  }
  if (reviewed) {
    for (const finding of reviewed.findings || []) store.saveFinding({...finding,source:'chat-interpretation'});
    store.set('profile_review',reviewed.coverage || {});
  }
  store.set('profile_generated_at',Date.now());
  return profile(store);
}

export function profile(store) {
  const corpus=store.ownCorpus();
  const coverage={messages:corpus.length,conversations:new Set(corpus.map(m=>m.room_id)).size,
    first:corpus.length ? corpus[0].ts : null,last:corpus.length ? corpus.at(-1).ts : null,
    platforms:[...new Set(corpus.map(m=>m.platform))],review:store.get('profile_review',{}),generatedAt:store.get('profile_generated_at',null)};
  return {coverage,findings:store.findings(),topics:scanTopics(corpus).map(({examples,...topic})=>topic),
    note:'Your stated preferences, recurring observations, and dated situations are kept distinct. Only eligible messages from your own accounts support findings. You can review and edit each interpretation; conversation suggestions are not predictions of what you will always join.'};
}

export function conversationFit(store,roomId) {
  const room=store.room(roomId);
  if (!room) return null;
  const own=store.ownCorpus();
  const positiveTopics=new Set(scanTopics(own).filter(t=>t.count>=3).map(t=>t.id));
  for (const finding of store.findings().filter(f=>['Core interests','Beyond work','Explorations','Topics you discuss'].includes(f.category) && (f.status==='confirmed' || f.confidence==='explicit'))) for (const tag of finding.tags) positiveTopics.add(tag);
  const recent=store.messages({room:roomId,limit:100});
  const combined=[room.name,room.server_name,...recent.map(m=>m.body)].join('\n');
  const matches=TOPICS.filter(t=>positiveTopics.has(t.id)&&t.pattern.test(combined)).map(t=>t.name);
  const label=room.followed ? 'You follow this' : room.own_count>=3 ? 'You participate here' : matches.length>=2 ? 'Possible fit' : matches.length ? 'Some overlap' : 'Not enough evidence';
  return {label,matches,participation:room.own_count,explanation:room.own_count ? 'You have '+room.own_count+' messages in the available archive for this conversation.' : matches.length ? 'Recent available messages overlap with topics you discuss. This is a suggestion, not a prediction.' : 'No reliable preference signal in the available messages. Lack of participation is not a dislike.'};
}

import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';

const same=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
export function serveLaptopActivity(activity,{relayToken,readerToken,ownerAllowed,port=8797}={}){
 const server=http.createServer(async(req,res)=>{
  const auth=req.headers.authorization,relay=same(auth,'Bearer '+relayToken),reader=same(auth,'Bearer '+readerToken);
  if(!relay&&!reader){res.writeHead(401).end();return;}
  if(req.method!=='POST'){res.writeHead(404).end();return;}
  try{
   const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>1000000)throw Error('Activity request too large.');chunks.push(chunk);}
   const args=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');let result;
   if(req.url==='/publish'&&relay)result=activity.ingest(args);
   else if(req.url==='/status'){if(relay)activity.paired(args.worker);result=activity.status();}
   else if(req.url==='/read'&&reader)result=activity.read();
   else if(req.url==='/control'){
    if(relay)activity.paired(args.worker);else if(!ownerAllowed(args.ownerMessageId))throw Error('A current owner request is required to change activity controls.');
    result=activity.control(args.paused);
   }else throw Error('Unsupported activity operation.');
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(result));
  }catch{res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Activity request rejected.'}));}
 });server.requestTimeout=15000;server.listen(port,'127.0.0.1');return server;
}

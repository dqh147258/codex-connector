import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { parseEnvelope, START_MARKER, END_MARKER } from './protocol.js';
import type { Connector } from './connector.js';
async function jsonBody(req:IncomingMessage){
  if(!req.headers['content-type']?.startsWith('application/json'))throw Error('BAD_CONTENT_TYPE');const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>65536)throw Error('BODY_TOO_LARGE');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function apiServer(connector:Connector,token:string){return createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  const got=Buffer.from(req.headers.authorization||''),want=Buffer.from(`Bearer ${token}`);
  if(req.headers.origin||!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host||'')||got.length!==want.length||!timingSafeEqual(got,want)){res.writeHead(401);res.end('{"error":"Unauthorized"}');return;}
  try{
    if(req.method!=='POST'||req.url!=='/v1/command'){res.writeHead(404);res.end('{"error":"Not found"}');return;}
    const body=await jsonBody(req);let result;
    if(body.action==='status')result=connector.status();
    else if(body.action==='recover'&&['command','outbox'].includes(body.kind)&&typeof body.id==='string'){connector.recover(body.kind,body.id,body.observedTs);result={recovered:body.id};}
    else if(body.action==='command'){const envelope=parseEnvelope(`${START_MARKER}\n${JSON.stringify(body.envelope)}\n${END_MARKER}`,connector.config.instanceId);result=connector.local(envelope);}
    else throw Error('UNKNOWN_ACTION');
    res.end(JSON.stringify({ok:true,result}));
  }catch{res.writeHead(400);res.end('{"error":"Request rejected; check command schema, identity and local status"}');}
});}

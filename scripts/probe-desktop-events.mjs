// Bounded read-only observer of the installed desktop IPC. No turns, approvals, or model requests.
// Store aggregate event metadata only; never write message text or the thread snapshot.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const threadId=process.argv[2]??process.env.CODEX_THREAD_ID;
if(!/^[0-9a-f-]{36}$/i.test(threadId??''))throw new Error('Explicit thread UUID required');
const socket=net.createConnection('\\\\.\\pipe\\codex-ipc');
let buffer=Buffer.alloc(0),clientId='initializing-client',ownerId,closed=false,following=false;
const requests=new Map(),report={startedAt:new Date().toISOString(),transport:'windows-named-pipe',initialized:false,ownerFound:false,threadId,events:[],counts:{},contentStored:false,modelRequests:0};
function send(message){if(!socket.destroyed) {const payload=Buffer.from(JSON.stringify(message));const frame=Buffer.alloc(4+payload.length);frame.writeUInt32LE(payload.length);payload.copy(frame,4);socket.write(frame);}}
function request(method,params,version=1){const requestId=randomUUID();requests.set(requestId,method);send({type:'request',requestId,sourceClientId:clientId,version,method,params,timeoutMs:2500});}
function follow(value){if(!ownerId)return;send({type:'broadcast',method:'thread-stream-following-changed',sourceClientId:clientId,targetClientIds:[ownerId],version:1,params:{conversationId:threadId,hostId:'local',following:value}});following=value;}
function event(message){
  if(message.type==='client-discovery-request'){send({type:'client-discovery-response',requestId:message.requestId,response:{canHandle:false}});return;}
  if(message.type==='request'){send({type:'response',requestId:message.requestId,resultType:'error',error:'observer-read-only'});return;}
  if(message.type==='response'){
    const method=requests.get(message.requestId);requests.delete(message.requestId);
    if(method==='initialize'&&message.resultType==='success'){
      clientId=message.result?.clientId;report.initialized=typeof clientId==='string';console.log(JSON.stringify({stage:'initialized',success:report.initialized}));request('thread-owner-discovery',{hostId:'local',conversationId:threadId});
    }else if(method==='thread-owner-discovery'){
      report.ownerFound=message.resultType==='success'&&typeof message.handledByClientId==='string';
      if(report.ownerFound){ownerId=message.handledByClientId;follow(true);}console.log(JSON.stringify({stage:'owner-discovery',success:report.ownerFound}));
    }return;
  }
  if(message.type!=='broadcast'||message.params?.conversationId!==threadId)return;
  const change=message.params?.change;
  const metadata={receivedAt:Date.now(),method:message.method,version:message.version,paramKeys:Object.keys(message.params??{}),changeType:change?.type??null,changeKeys:Object.keys(change??{}),patchCount:Array.isArray(change?.patches)?change.patches.length:null,textChangeCount:Array.isArray(change?.acceptedTextChanges)?change.acceptedTextChanges.length:null};
  if(change?.conversationState) {metadata.stateKeys=Object.keys(change.conversationState);const state=change.conversationState;metadata.turnHistoryKeys=Object.keys(state.turnHistory??{});metadata.historyKeys=Object.keys(state.turnHistory?.history??{});const entity=Object.values(state.turnHistory?.history?.entitiesByKey??{}).at(-1);metadata.entityKeys=Object.keys(entity??{});metadata.turnStatus=entity?.status;metadata.itemTypes=entity?.items?.slice(-12).map(item=>({type:item.type,textChars:typeof item.text==='string'?Array.from(item.text).length:null}));metadata.usageTotalKeys=Object.keys(state.latestTokenUsageInfo?.total??{});}
  if(Array.isArray(change?.patches))metadata.patchShapes=change.patches.slice(0,12).map(p=>({op:p.op,path:Array.isArray(p.path)?p.path.map(k=>typeof k==='number'?k:typeof k==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)?k:'<key>'):typeof p.path,valueType:Array.isArray(p.value)?'array':typeof p.value,valueLength:typeof p.value==='string'?p.value.length:null,valueKeys:p.value&&typeof p.value==='object'&&!Array.isArray(p.value)?Object.keys(p.value).slice(0,16):undefined,valueKind:['agentMessage','reasoning','commandExecution','mcpToolCall','functionCall','userMessage'].includes(p.value?.type)?p.value.type:null,agentChars:p.value?.type==='agentMessage'&&typeof p.value.text==='string'?Array.from(p.value.text).length:null}));
  report.counts[message.method]=(report.counts[message.method]??0)+1;
  if(report.events.length<100)report.events.push(metadata);
  if(report.events.length<=5||report.events.length%20===0)console.log(JSON.stringify(metadata));
}
async function finish(reason){if(closed)return;closed=true;report.endedAt=new Date().toISOString();report.reason=reason;if(following)follow(false);await writeFile(new URL('../QA/desktop-live-events-probe-20261015.json',import.meta.url),JSON.stringify(report,null,2)+'\n');setTimeout(()=>socket.destroy(),100);}
socket.on('connect',()=>request('initialize',{clientType:'codex-pulse-monitor'},0));
socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const size=buffer.readUInt32LE(0);if(size===0||size>32*1024*1024){void finish('frame-limit');return;}if(buffer.length<size+4)return;const frame=buffer.subarray(4,4+size);buffer=buffer.subarray(size+4);try{event(JSON.parse(frame.toString('utf8')));}catch{void finish('parse-error');}}});
socket.on('error',error=>{report.errorCode=error.code;void finish('connection-error');});
socket.on('close',()=>{clearTimeout(deadline);void finish('closed');});
const deadline=setTimeout(()=>void finish('bounded-probe-complete'),Math.max(5000,Math.min(120000,Number(process.argv[3])||30000)));
process.on('SIGTERM',()=>void finish('terminated'));

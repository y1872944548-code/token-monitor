// Read-only, version-gated adapter for the installed Windows desktop IPC.
// Keep message IDs and character counts, never message text or reasoning content.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
const numeric=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const usage=raw=>raw?{total_tokens:numeric(raw.totalTokens),input_tokens:numeric(raw.inputTokens),cached_input_tokens:numeric(raw.cachedInputTokens),output_tokens:numeric(raw.outputTokens),reasoning_output_tokens:numeric(raw.reasoningOutputTokens)}:null;
const itemPath=path=>path.length>=6&&path[0]==='turnHistory'&&path[1]==='history'&&path[2]==='entitiesByKey'&&path[4]==='items';
export class DesktopMetrics {
  constructor({onTextDelta=()=>{}}={}){this.onTextDelta=onTextDelta;this.reset();}
  reset(){this.revision=null;this.synced=false;this.turns=new Map();this.paths=new Map();this.lengths=new Map();this.events=[];this.points=[];this.characters=0;this.lastTextAt=null;this.officialUsage=null;this.officialObservedAt=null;this.eventCount=0;}
  remember(path,item,now,baseline=false){
    const key=JSON.stringify(path);if(!item||item.type!=='agentMessage'||typeof item.id!=='string'||typeof item.text!=='string'){this.paths.delete(key);return;}
    const length=Array.from(item.text).length,previous=this.lengths.get(item.id)??0;
    // Keep a high-water mark across replay, reconnect and temporary truncation.
    // Recounting a previously observed range would inflate the two-second rate.
    this.paths.set(key,{id:item.id,type:'agentMessage'});this.lengths.set(item.id,Math.max(previous,length));
    if(!baseline&&this.turns.get(String(path[3]))==='inProgress'&&length>previous){const delta=length-previous;this.events.push({time:now,count:delta});this.characters+=delta;this.lastTextAt=now;this.onTextDelta({id:item.id,from:previous,to:length,time:now});}
    if(this.lengths.size>5000){this.lengths.delete(this.lengths.keys().next().value);this.paths.delete(this.paths.keys().next().value);}
  }
  tokenInfo(info,now,baseline){const next=usage(info?.total);if(next?.total_tokens===null||!next)return;
    const changed=this.officialUsage&&next.total_tokens!==this.officialUsage.total_tokens;
    this.officialUsage=next;if(!baseline&&changed)this.officialObservedAt=now;
  }
  accept(change,now=Date.now()){
    this.eventCount++;
    if(change?.type==='snapshot'){
      const state=change.conversationState;if(!state||!Number.isInteger(change.revision))return false;
      this.paths.clear();this.turns.clear();
      for(const [key,turn]of Object.entries(state.turnHistory?.history?.entitiesByKey??{})){
        this.turns.set(key,turn.status);if(Array.isArray(turn.items))turn.items.forEach((item,index)=>this.remember(['turnHistory','history','entitiesByKey',key,'items',index],item,now,true));
      }
      this.officialObservedAt=null;this.tokenInfo(state.latestTokenUsageInfo,now,true);this.revision=change.revision;this.synced=true;return true;
    }
    if(change?.type!=='patches'||!this.synced||change.baseRevision!==this.revision||!Number.isInteger(change.revision)||change.revision<=change.baseRevision||!Array.isArray(change.patches)){this.synced=false;return false;}
    for(const patch of change.patches){
      const path=patch.path;if(!Array.isArray(path)||path.length>32||path.some(k=>!['string','number'].includes(typeof k)||['__proto__','prototype','constructor'].includes(k)))continue;
      if(path.length===1&&path[0]==='latestTokenUsageInfo'){this.tokenInfo(patch.value,now,false);continue;}
      if(path[0]!=='turnHistory'||path[1]!=='history'||path[2]!=='entitiesByKey')continue;
      if(path.length===4&&patch.value&&typeof patch.value==='object'){
        const known=this.turns.has(String(path[3]));this.turns.set(String(path[3]),patch.value.status);if(Array.isArray(patch.value.items))patch.value.items.forEach((item,index)=>this.remember([...path,'items',index],item,now,known||patch.value.status!=='inProgress'));continue;
      }
      if(path.length===5&&path[4]==='status'){this.turns.set(String(path[3]),patch.value);continue;}
      if(!itemPath(path))continue;
      if(path.length===6){if(patch.op==='remove')this.paths.delete(JSON.stringify(path));else this.remember(path,patch.value,now);}
      else if(path.length===7&&path[6]==='text'&&typeof patch.value==='string'){
        const base=path.slice(0,6),known=this.paths.get(JSON.stringify(base));if(known)this.remember(base,{type:'agentMessage',id:known.id,text:patch.value},now);
      }
    }
    this.revision=change.revision;return true;
  }
  snapshot(now=Date.now()){
    this.events=this.events.filter(event=>event.time>now-2000);const rate=this.events.reduce((sum,event)=>sum+event.count,0)/2;
    if(this.synced&&(!this.points.length||now-this.points.at(-1).time>=500)){this.points.push({time:now,rate});if(this.points.length>250)this.points.shift();}
    return {synchronized:this.synced,revision:this.revision,rate,unit:'characters/s',windowSeconds:2,characters:this.characters,lastTextAt:this.lastTextAt,eventCount:this.eventCount,officialUsage:this.officialUsage,officialObservedAt:this.officialObservedAt,points:this.points};
  }
}
export class DesktopEvents {
  constructor({threadId,onChange=()=>{},onTextDelta=()=>{},onThreadActivity=()=>{},discoveryOnly=false,retryUnowned=true,endpoint='\\\\.\\pipe\\codex-ipc',now=Date.now,reconnectMs=2000}){this.threadId=threadId;this.onChange=onChange;this.onThreadActivity=onThreadActivity;this.discoveryOnly=discoveryOnly;this.retryUnowned=retryUnowned;this.endpoint=endpoint;this.now=now;this.reconnectMs=reconnectMs;this.metrics=new DesktopMetrics({onTextDelta});this.enabled=false;this.connected=false;this.errorCode=null;this.requests=new Map();}
  start(){if(this.enabled)return;this.enabled=true;this.connect();}
  connect(){
    if(!this.enabled)return;this.buffer=Buffer.alloc(0);this.clientId='initializing-client';this.ownerId=null;this.metrics.synced=false;this.requests.clear();
    const socket=this.socket=net.createConnection(this.endpoint);this.deadline=setTimeout(()=>{this.errorCode='handshake-timeout';socket.destroy();},4000);
    socket.on('connect',()=>this.request('initialize',{clientType:'codex-pulse-monitor'},0));
    socket.on('data',chunk=>{
      if(this.socket!==socket)return;
      this.buffer=Buffer.concat([this.buffer,chunk]);while(this.buffer.length>=4){const size=this.buffer.readUInt32LE(0);if(size===0||size>32*1024*1024){this.errorCode='frame-limit';socket.destroy();return;}if(this.buffer.length<size+4)return;
        const frame=this.buffer.subarray(4,size+4);this.buffer=this.buffer.subarray(size+4);try{this.receive(JSON.parse(frame.toString('utf8')));}catch{this.errorCode='protocol-error';socket.destroy();return;}}
    });
    socket.on('error',error=>{if(this.socket===socket)this.errorCode=error.code??'connection-error';});
    socket.on('close',()=>{if(this.socket!==socket)return;clearTimeout(this.deadline);this.connected=false;this.metrics.synced=false;this.onChange();if(this.enabled)this.retry=setTimeout(()=>this.connect(),this.reconnectMs);});
  }
  send(message){if(!this.socket?.writable)return;const payload=Buffer.from(JSON.stringify(message));const frame=Buffer.alloc(payload.length+4);frame.writeUInt32LE(payload.length);payload.copy(frame,4);this.socket.write(frame);}
  request(method,params,version=1){if(!['initialize','thread-owner-discovery'].includes(method))throw new Error('Observer cannot invoke mutation requests');const requestId=randomUUID();this.requests.set(requestId,method);this.send({type:'request',requestId,sourceClientId:this.clientId,version,method,params,timeoutMs:2500});}
  follow(following){if(!this.ownerId)return;this.send({type:'broadcast',method:'thread-stream-following-changed',sourceClientId:this.clientId,targetClientIds:[this.ownerId],version:1,params:{conversationId:this.threadId,hostId:'local',following}});}
  receive(message){
    if(message.type==='client-discovery-request'){this.send({type:'client-discovery-response',requestId:message.requestId,response:{canHandle:false}});return;}
    if(message.type==='request'){this.send({type:'response',requestId:message.requestId,resultType:'error',error:'observer-read-only'});return;}
    if(message.type==='response'){
      const method=this.requests.get(message.requestId);this.requests.delete(message.requestId);
      if(method==='initialize'&&message.resultType==='success'&&typeof message.result?.clientId==='string'){this.clientId=message.result.clientId;if(this.discoveryOnly){clearTimeout(this.deadline);this.connected=true;this.onChange();}else this.request('thread-owner-discovery',{hostId:'local',conversationId:this.threadId});}
      else if(method==='thread-owner-discovery'&&message.resultType==='success'&&typeof message.handledByClientId==='string'){this.ownerId=message.handledByClientId;this.connected=true;this.errorCode=null;this.follow(true);}
      else if(method==='thread-owner-discovery'){this.errorCode='owner-not-loaded';if(!this.retryUnowned)this.enabled=false;this.socket?.destroy();}
      return;
    }
    if(message.type==='broadcast'&&['thread-stream-following-status-requested','thread-stream-following-changed'].includes(message.method)&&message.params?.hostId==='local'&&(message.method!=='thread-stream-following-changed'||message.params.following)&&typeof message.params.conversationId==='string')this.onThreadActivity(message.params.conversationId);
    if(message.type!=='broadcast'||message.method!=='thread-stream-state-changed'||message.params?.conversationId!==this.threadId)return;
    if(message.targetClientIds&&!message.targetClientIds.includes(this.clientId))return;
    if(message.version!==11){this.errorCode='unsupported-stream-version';this.socket.destroy();return;}
    if(this.metrics.accept(message.params.change,this.now())){clearTimeout(this.deadline);this.onChange();}
    else {this.follow(false);this.follow(true);}
  }
  snapshot(){return {connected:this.connected,errorCode:this.errorCode,...this.metrics.snapshot(this.now())};}
  stop(){this.enabled=false;clearTimeout(this.retry);clearTimeout(this.deadline);this.follow(false);const socket=this.socket;this.socket=null;socket?.end();setTimeout(()=>socket?.destroy(),100).unref();this.connected=false;this.metrics.synced=false;}
}

import {open,stat} from 'node:fs/promises';
import {normalizeUsage,normalizeLimits} from './metrics.mjs';
import {insideRoots} from './thread-catalog.mjs';
const BLOCK=8*1024*1024,keys=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
export class GlobalMetrics {
  constructor(since){this.since=since;this.usage=Object.fromEntries(keys.map(key=>[key,0]));this.responses=new Set();this.threads=new Set();this.limits=null;this.observedAt=null;this.missing=0;this.tokenEvents=[];this.textEvents=[];this.ranges=new Map();this.characters=0;this.points=[];this.tokenPoints=[];this.files=new Map();this.checked=new Map();this.failures=new Map();this.ledgerFiles=new Set();this.legacyFiles=new Map();this.loading=0;this.readErrors=0;}
  accept(record,threadId){const time=Date.parse(record.timestamp);if(!Number.isFinite(time))return;
    if(record.type==='event_msg'&&record.payload?.rate_limits&&time>(this.limits?.observedAt??0))this.limits={...normalizeLimits(record.payload.rate_limits),observedAt:time};
    if(time>=this.since&&record.type==='event_msg'&&record.payload?.type==='token_count'&&!this.ledgerFiles.has(threadId))this.legacyFiles.set(threadId,time);
    if(time<this.since||record.type!=='token_usage_record')return;
    this.ledgerFiles.add(threadId);this.legacyFiles.delete(threadId);
    const payload=record.payload??{},usage=normalizeUsage(payload.usage);if(typeof payload.response_id!=='string'||usage.total_tokens===null){this.missing++;return;}
    if(this.responses.has(payload.response_id))return;this.responses.add(payload.response_id);this.threads.add(payload.thread_id??threadId);
    for(const key of keys)if(usage[key]!==null)this.usage[key]+=usage[key];this.observedAt=Math.max(this.observedAt??0,time);if(usage.output_tokens!==null)this.tokenEvents.push({time,count:usage.output_tokens});
  }
  acceptText({id,from,to,time}){if(time<this.since||!Number.isFinite(from)||!Number.isFinite(to)||to<=from)return;
    const ranges=this.ranges.get(id)??[];let count=to-from;for(const [start,end]of ranges)count-=Math.max(0,Math.min(to,end)-Math.max(from,start));
    const all=[...ranges,[from,to]].sort((a,b)=>a[0]-b[0]),merged=[];for(const range of all){const last=merged.at(-1);if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else merged.push([...range]);}this.ranges.set(id,merged);
    if(count>0){this.characters+=count;this.textEvents.push({time,count});}
  }
  parse(buffer,id){let oldest=Infinity;for(const line of buffer.toString('utf8').split('\n')){if(!line.includes('"token_usage_record"')&&!line.includes('"event_msg"'))continue;try{const record=JSON.parse(line);if(!['event_msg','token_usage_record'].includes(record.type))continue;const time=Date.parse(record.timestamp);if(Number.isFinite(time))oldest=Math.min(oldest,time);this.accept(record,id);}catch{}}return oldest;}
  async read(entry,roots){let handle;try{
    if(!this.files.has(entry.id)&&this.checked.get(entry.id)===entry.modifiedAt&&(!this.failures.has(entry.id)||Date.now()-this.failures.get(entry.id)<5000)){if(this.failures.has(entry.id))this.readErrors++;return;}
    const file=await insideRoots(entry.file,roots);const info=await stat(file);if(info.mtimeMs<this.since&&!this.files.has(entry.id))return;
    let state=this.files.get(entry.id);if(!state){state={file,position:info.size,back:info.size,carry:Buffer.alloc(0),pending:Buffer.alloc(0),initial:true};this.files.set(entry.id,state);}
    if(state.file!==file||info.size<state.position){this.files.delete(entry.id);return this.read(entry,roots);}
    handle=await open(file,'r');
    if(state.back>0){const start=Math.max(0,state.back-BLOCK),data=Buffer.alloc(state.back-start);await handle.read(data,0,data.length,start);let joined=Buffer.concat([data,state.carry]);
      if(state.initial){const last=joined.lastIndexOf(10);state.pending=joined.subarray(last+1);joined=joined.subarray(0,last+1);state.initial=false;}
      const first=joined.indexOf(10);const ready=start>0?(first>=0?joined.subarray(first+1):Buffer.alloc(0)):joined;
      state.carry=start>0?(first>=0?joined.subarray(0,first+1):joined):Buffer.alloc(0);if(state.carry.length>BLOCK)state.carry=Buffer.alloc(0);const oldest=this.parse(ready,entry.id);state.back=oldest<this.since?0:start;if(state.back===0)state.carry=Buffer.alloc(0);
    }else if(info.size>state.position){const size=Math.min(BLOCK,info.size-state.position),data=Buffer.alloc(size);const {bytesRead}=await handle.read(data,0,size,state.position);state.position+=bytesRead;const joined=Buffer.concat([state.pending,data.subarray(0,bytesRead)]),last=joined.lastIndexOf(10);if(last>=0){this.parse(joined.subarray(0,last),entry.id);state.pending=joined.subarray(last+1);}else state.pending=joined;}
    state.remaining=info.size-state.position;this.failures.delete(entry.id);
  }catch{if(entry.modifiedAt>=this.since||this.files.has(entry.id)){this.readErrors++;this.failures.set(entry.id,Date.now());}}finally{this.checked.set(entry.id,entry.modifiedAt);await handle?.close();}}
  async tick(entries,roots){this.readErrors=0;for(let i=0;i<entries.length;i+=4)await Promise.all(entries.slice(i,i+4).map(entry=>this.read(entry,roots)));this.loading=[...this.files.values()].filter(state=>state.back>0||state.remaining>0).length;}
  snapshot(now=Date.now()){
    this.textEvents=this.textEvents.filter(event=>event.time>now-2000);this.tokenEvents=this.tokenEvents.filter(event=>event.time>now-120000);
    const rate=this.textEvents.reduce((sum,event)=>sum+event.count,0)/2;
    const interval=Math.max(1,Math.min(120,(now-this.since)/1000)),tokenRate=this.tokenEvents.reduce((sum,event)=>sum+event.count,0)/interval;
    if(!this.points.length||now-this.points.at(-1).time>=500){this.points.push({time:now,rate});this.tokenPoints.push({time:now,rate:tokenRate});if(this.points.length>250){this.points.shift();this.tokenPoints.shift();}}
    return {usage:{...this.usage},limits:this.limits,observedAt:this.observedAt,ageSeconds:this.observedAt===null?null:Math.max(0,(now-this.observedAt)/1000),latestRate:tokenRate,rateIntervalSeconds:interval,points:this.points,tokenPoints:this.tokenPoints,rate,characters:this.characters,contributingThreads:this.threads.size,loading:this.loading,readErrors:this.readErrors,missingDetails:this.missing+[...this.legacyFiles.values()].filter(time=>now-time>3000).length};
  }
}

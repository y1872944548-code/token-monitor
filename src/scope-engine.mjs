import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {watch} from 'node:fs';
import path from 'node:path';
import {Monitor} from './monitor.mjs';
import {ThreadCatalog,isId} from './thread-catalog.mjs';
import {GlobalMetrics} from './global-metrics.mjs';
import {DesktopEvents} from './desktop-events.mjs';
export class ScopeEngine {
  constructor({threadId,settingsFile,catalog=new ThreadCatalog(),desktopEnabled=process.platform==='win32'&&process.env.CODEX_PULSE_DISABLE_DESKTOP_EVENTS!=='1',sourceFactory=options=>new DesktopEvents(options),onChange=()=>{}}){this.defaultId=threadId;this.settingsFile=settingsFile;this.catalog=catalog;this.desktopEnabled=desktopEnabled;this.sourceFactory=sourceFactory;this.onChange=onChange;this.config={mode:'thread',threadId,globalStartedAt:null};this.sources=new Map();this.queued=[];this.examine=[];this.examined=new Map();this.enabled=true;this.watchers=[];this.lastLedger=0;this.controlError=null;}
  async initialize(){try{const value=JSON.parse(await readFile(this.settingsFile,'utf8'));if(['thread','all'].includes(value.mode)&&isId(value.threadId))this.config={mode:value.mode,threadId:value.threadId,globalStartedAt:Number.isFinite(value.globalStartedAt)&&value.globalStartedAt>0?value.globalStartedAt:null};}catch{}
    await this.catalog.refresh(true);if(this.config.mode==='all'&&this.catalog.restricted){this.pendingGlobal=true;this.config.mode='thread';}
    if(this.config.mode==='all'&&!this.config.globalStartedAt){this.config.globalStartedAt=Date.now();await this.persist(this.config);}
    this.configure();this.watchRoots();
  }
  async persist(value){await mkdir(path.dirname(this.settingsFile),{recursive:true});await writeFile(this.settingsFile+'.tmp',JSON.stringify(value,null,2)+'\n');await rename(this.settingsFile+'.tmp',this.settingsFile);}
  async select({mode,threadId=this.config.threadId,resetGlobal=false}){await this.catalog.refresh(true);if(!['thread','all'].includes(mode)||!isId(threadId))throw new Error('监控范围无效');if(mode==='thread'&&!this.catalog.entries.some(row=>row.id===threadId))throw new Error('未找到所选本机聊天');if(mode==='all'&&this.catalog.restricted)throw new Error('本机聊天索引不可用，不能将局部数据冒充全局');
    const next={mode,threadId,globalStartedAt:mode==='all'&&(resetGlobal||!this.config.globalStartedAt)?Date.now():this.config.globalStartedAt};await this.persist(next);
    this.pendingGlobal=false;if(JSON.stringify(next)!==JSON.stringify(this.config)){this.config=next;this.configure();}this.controlError=null;
  }
  configure(){this.singleDesktop?.stop();this.discovery?.stop();for(const source of this.sources.values())source.stop();this.sources.clear();this.queued=[];this.examine=[];this.examined.clear();
    this.single=new Monitor({root:this.catalog.roots[0],extraRoots:this.catalog.roots.slice(1),threadId:this.config.threadId,catalog:async()=>this.catalog.entries});
    this.global=this.config.mode==='all'?new GlobalMetrics(this.config.globalStartedAt):null;
    if(this.desktopEnabled&&this.config.mode==='thread'){this.singleDesktop=this.sourceFactory({threadId:this.config.threadId,onChange:this.onChange});if(this.enabled)this.singleDesktop.start();}
    else this.singleDesktop=null;
    if(this.desktopEnabled&&this.config.mode==='all'){this.discovery=this.sourceFactory({threadId:this.defaultId,discoveryOnly:true,onChange:this.onChange,onThreadActivity:id=>{if(isId(id)&&this.config.mode==='all'){this.queueStream(id,true);this.onChange();}}});if(this.enabled)this.discovery.start();}else this.discovery=null;
    this.lastLedger=0;
  }
  watchRoots(){for(const watcher of this.watchers)watcher.close();this.watchers=[];if(!this.enabled)return;for(const root of this.catalog.roots)try{this.watchers.push(watch(root,{recursive:true},(_event,file)=>{if(!this.enabled)return;const match=String(file??'').match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);if(!match)return;this.catalog.lastRefresh=0;if(this.config.mode==='all'){this.global?.checked.delete(match[1]);this.queueStream(match[1],true);}this.single.lastDiscover=0;this.onChange();}));}catch{}}
  queueStream(id,retry=false){if(!this.desktopEnabled||!isId(id))return;const source=this.sources.get(id);if(source&&(source.connected||source.enabled))return;if(!this.queued.includes(id)&&(retry||!source))this.queued.push(id);}
  pumpStreams(){let pending=[...this.sources.values()].filter(source=>source.enabled&&!source.connected).length;while(this.enabled&&pending<4&&this.queued.length){const id=this.queued.shift();let source=this.sources.get(id);if(!source){source=this.sourceFactory({threadId:id,retryUnowned:false,onChange:this.onChange,onTextDelta:delta=>{if(this.config.mode==='all')this.global?.acceptText(delta);}});this.sources.set(id,source);}source.start();pending++;}}
  async tick(){await this.catalog.refresh();if(this.pendingGlobal&&!this.catalog.restricted){this.pendingGlobal=false;this.config.mode='all';if(!this.config.globalStartedAt)this.config.globalStartedAt=Date.now();await this.persist(this.config);this.configure();this.watchRoots();}await this.single.tick();
    if(this.config.mode==='all'){
      for(const row of this.catalog.entries)if(this.examined.get(row.id)!==row.modifiedAt){this.examined.set(row.id,row.modifiedAt);this.examine.push(row);}
      const batch=this.examine.splice(0,32);await Promise.all(batch.map(async row=>{if(await this.catalog.active(row))this.queueStream(row.id,true);}));this.pumpStreams();
      if(Date.now()-this.lastLedger>=1000){await this.global.tick(this.catalog.entries,this.catalog.roots);this.lastLedger=Date.now();}
    }else{
      const live=this.singleDesktop?.snapshot();if(live?.connected&&live.synchronized&&live.officialObservedAt&&live.officialUsage?.total_tokens>(this.single.metrics.usage?.total_tokens??-1))this.single.metrics.accept({type:'token_usage_record',timestamp:new Date(live.officialObservedAt).toISOString(),payload:{thread_token_usage:live.officialUsage}});
    }
  }
  snapshot(){const single=this.single.snapshot(),now=single.now;let value=single;const title=this.catalog.entries.find(row=>row.id===this.config.threadId)?.title??'';
    let scope={mode:this.config.mode,threadId:this.config.threadId,title,startedAt:this.config.globalStartedAt,indexAvailable:!this.catalog.restricted};
    if(this.config.mode==='all'){
      const data=this.global.snapshot(now),streams=[...this.sources.values()].map(source=>source.snapshot()),ready=streams.filter(row=>row.connected&&row.synchronized),pending=streams.filter(row=>!row.connected&&row.errorCode!=='owner-not-loaded').length+this.queued.length;
      const limits=[single.limits,data.limits].filter(Boolean).sort((a,b)=>(b.observedAt??0)-(a.observedAt??0))[0]??null;
      scope={...scope,contributingThreads:data.contributingThreads,connectedStreams:ready.length,pendingStreams:pending,unavailableStreams:streams.filter(row=>row.errorCode==='owner-not-loaded').length,discovering:this.examine.length>0||pending>0,loading:data.loading,readErrors:data.readErrors,missingDetails:data.missingDetails,catalogThreads:this.catalog.entries.length};
      value={...single,...data,points:ready.length?data.points:data.tokenPoints,selectedId:null,now,limits,status:ready.length?'running':single.status,lastActivity:ready.length?now:single.lastActivity,error:this.catalog.restricted?'本机索引暂不可用，范围未完整':data.readErrors?'部分本机日志暂不可读':null,chartMetric:ready.length?'visible-characters-per-second':'global-reported-token-rate',liveOutput:{connected:ready.length>0,synchronized:ready.length>0,rate:data.rate,characters:data.characters,unit:'characters/s',windowSeconds:2,connectedStreams:ready.length,pendingStreams:pending}};
    }else{const live=this.singleDesktop?.snapshot();if(live){const {points,officialUsage,...summary}=live;value.liveOutput=summary;if(live.connected&&live.synchronized){value.points=points;value.chartMetric='visible-characters-per-second';value.lastActivity=Math.max(value.lastActivity??0,live.lastTextAt??0);}}}
    return {...value,error:this.pendingGlobal?'等待本机 Codex 初始化聊天索引':value.error,reportedPoints:this.config.mode==='all'?value.tokenPoints:single.points,scope:{...scope,pendingGlobal:!!this.pendingGlobal},controlError:this.controlError};
  }
  pause(){this.enabled=false;this.singleDesktop?.stop();this.discovery?.stop();for(const source of this.sources.values())source.stop();for(const watcher of this.watchers)watcher.close();this.watchers=[];}
  resume(){if(this.enabled)return;this.enabled=true;this.singleDesktop?.start();this.discovery?.start();for(const source of this.sources.values())source.start();this.catalog.lastRefresh=0;this.watchRoots();}
  close(){this.pause();}
}

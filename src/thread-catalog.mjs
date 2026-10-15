import { access,open,realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Monitor } from './monitor.mjs';
export const isId=id=>typeof id==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
export function standardPath(value){let file=String(value);if(process.platform==='win32'){if(file.startsWith('\\\\?\\UNC\\'))file='\\\\'+file.slice(8);else if(file.startsWith('\\\\?\\'))file=file.slice(4);}return path.resolve(file);}
export class ThreadCatalog {
  constructor({home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex')}={}){this.home=standardPath(home);this.roots=[path.join(this.home,'sessions'),path.join(this.home,'archived_sessions')];this.entries=[];this.lastRefresh=0;this.restricted=true;}
  async refresh(force=false){
    if(!force&&Date.now()-this.lastRefresh<3000)return this.entries;this.lastRefresh=Date.now();
    try{const file=path.join(this.home,'state_5.sqlite');await access(file);const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file,{readOnly:true});
      try{this.entries=db.prepare('SELECT id,title,rollout_path,updated_at,created_at,archived FROM threads ORDER BY updated_at DESC').all().flatMap(row=>{
        const file=standardPath(row.rollout_path);if(!isId(row.id)||!file.toLowerCase().endsWith(row.id.toLowerCase()+'.jsonl')||!this.roots.some(root=>{const relative=path.relative(root,file);return !relative.startsWith('..')&&!path.isAbsolute(relative);}))return[];
        return[{id:row.id,title:typeof row.title==='string'?row.title.slice(0,160):'',file,modifiedAt:row.updated_at*1000,createdAt:row.created_at*1000,archived:!!row.archived}];
      });this.restricted=false;}finally{db.close();}
    }catch{const fallback=new Monitor({root:this.roots[0]});await fallback.discover();this.entries=fallback.sessions.map(row=>({...row,title:'',createdAt:null}));this.restricted=true;}
    return this.entries;
  }
  async active(entry){
    let handle;try{handle=await open(await insideRoots(entry.file,this.roots),'r');const info=await handle.stat(),length=Math.min(info.size,65536),buffer=Buffer.alloc(length);await handle.read(buffer,0,length,info.size-length);
      const lines=buffer.toString('utf8').split('\n');for(let i=lines.length-1;i>=0;i--){const line=lines[i];if(!line.includes('"event_msg"')||!/(task_started|task_complete|task_completed|turn_aborted)/.test(line))continue;try{const record=JSON.parse(line);if(record.type!=='event_msg')continue;const type=record.payload?.type;if(type==='task_started')return true;if(['task_complete','task_completed','turn_aborted'].includes(type))return false;}catch{}}
      return true; // Unknown is probed, not silently omitted.
    }catch{return false;}finally{await handle?.close();}
  }
  publicList(){return this.entries.map(({id,title,modifiedAt,archived})=>({id,title,modifiedAt,archived}));}
}
export async function insideRoots(file,roots){const actual=standardPath(await realpath(file));for(const root of roots){try{const relative=path.relative(standardPath(await realpath(root)),actual);if(!relative.startsWith('..')&&!path.isAbsolute(relative))return actual;}catch{}}throw new Error('Log path outside approved roots');}

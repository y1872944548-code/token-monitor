import test from'node:test';import assert from'node:assert/strict';import {spawn}from'node:child_process';import {mkdtemp,mkdir,writeFile,appendFile,rm}from'node:fs/promises';import path from'node:path';import os from'node:os';import {fileURLToPath}from'node:url';
const a='01a13949-b780-71a2-8863-a7f53db88ead',b='01a13b47-583a-7e01-884c-e76fb039ff14';
test('floating feed commands switch token and speed scope together, preserve epoch and expose searchable titles',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const home=await mkdtemp(path.join(os.tmpdir(),'pulse-mode-feed-'));assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep));let child;
 t.after(async()=>{if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,300);});}await rm(home,{recursive:true,force:true});});
 const root=path.join(home,'sessions');await mkdir(root);const fa=path.join(root,`rollout-${a}.jsonl`),fb=path.join(root,`rollout-${b}.jsonl`);
 const record=(id,response,total)=>JSON.stringify({timestamp:new Date().toISOString(),type:'token_usage_record',payload:{thread_id:id,response_id:response,usage:{total_tokens:total,input_tokens:total-1,output_tokens:1},thread_token_usage:{total_tokens:1000,output_tokens:10}}})+'\n';
 await writeFile(fa,record(a,'old-a',1000));await writeFile(fb,record(b,'old-b',1000));const db=new DatabaseSync(path.join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT,title TEXT,rollout_path TEXT,updated_at INTEGER,created_at INTEGER,archived INTEGER)');const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,0)');for(const [id,file,title]of [[a,fa,'对话甲'],[b,fb,'对话乙']])insert.run(id,title,file,Math.floor(Date.now()/1000),0);db.close();
 child=spawn(process.execPath,[fileURLToPath(new URL('../src/float-feed.mjs',import.meta.url)),'--thread',a],{env:{...process.env,CODEX_HOME:home,CODEX_PULSE_DISABLE_DESKTOP_EVENTS:'1',CODEX_PULSE_SETTINGS_FILE:path.join(home,'settings.json')},windowsHide:true});let latest,buffer='',catalog;
 child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){latest=JSON.parse(buffer.slice(0,end));if(latest.catalog)catalog=latest.catalog;buffer=buffer.slice(end+1);}});
 const wait=async fn=>{const end=Date.now()+5000;while(!fn()){assert.ok(Date.now()<end,'mode command timed out');await new Promise(resolve=>setTimeout(resolve,20));}};
 const send=request=>child.stdin.write(JSON.stringify({type:'scope',...request})+'\n');
 await wait(()=>latest?.scope?.mode==='thread');assert.deepEqual(catalog.map(row=>row.title).sort(),['对话乙','对话甲'].sort());
 send({mode:'all',threadId:a});await wait(()=>latest?.scope?.mode==='all');const since=latest.scope.startedAt;assert.equal(latest.selectedId,null);assert.equal(latest.usage.total_tokens,0);assert.equal(latest.chartMetric,'global-reported-token-rate');
 const shared=record(a,'new-a',31);await appendFile(fa,shared);await appendFile(fb,shared+record(b,'new-b',50));await wait(()=>latest?.usage?.total_tokens===81);assert.equal(latest.scope.contributingThreads,2);
 send({mode:'thread',threadId:b});await wait(()=>latest?.selectedId===b);assert.equal(latest.scope.title,'对话乙');assert.equal(latest.usage.total_tokens,1000);
 send({mode:'all',threadId:b});await wait(()=>latest?.scope?.mode==='all'&&latest.usage.total_tokens===81);assert.equal(latest.scope.startedAt,since);
});

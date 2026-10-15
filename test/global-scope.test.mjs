import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,appendFile,rm,readFile}from'node:fs/promises';import path from'node:path';import os from'node:os';
import {GlobalMetrics}from'../src/global-metrics.mjs';import {ScopeEngine}from'../src/scope-engine.mjs';
import {standardPath}from'../src/thread-catalog.mjs';
const a='01a13949-b780-71a2-8863-a7f53db88ead',b='01a13b47-583a-7e01-884c-e76fb039ff14';
const record=(time,id,response,total,out)=>({timestamp:new Date(time).toISOString(),type:'token_usage_record',payload:{thread_id:id,response_id:response,usage:{total_tokens:total,input_tokens:total-out,output_tokens:out},thread_token_usage:{total_tokens:999999,output_tokens:99999}}});
test('Windows indexed extended paths normalize before checking allowed roots',{skip:process.platform!=='win32'},()=>{assert.equal(standardPath('\\\\?\\C:\\Users\\example\\sessions\\rollout.jsonl'),path.resolve('C:\\Users\\example\\sessions\\rollout.jsonl'));});
test('global request totals deduplicate fork/replay and do not add inherited cumulative totals or account limits',()=>{
 const m=new GlobalMetrics(1000);m.accept(record(900,a,'old',100,10),a);const first=record(1100,a,'r1',100,10);m.accept(first,a);m.accept(first,b);m.accept(record(1200,b,'r2',200,20),b);
 assert.equal(m.snapshot(1300).usage.total_tokens,300);assert.equal(m.snapshot(1300).contributingThreads,2);
 m.accept({timestamp:new Date(1250).toISOString(),type:'event_msg',payload:{rate_limits:{primary:{used_percent:40}}}},a);assert.equal(m.snapshot(1300).limits.primary.usedPercent,40);
 m.acceptText({id:'visible',from:0,to:4,time:1200});m.acceptText({id:'visible',from:0,to:4,time:1201});m.acceptText({id:'visible',from:2,to:6,time:1202});m.acceptText({id:'other',from:0,to:2,time:1203});assert.equal(m.snapshot(1300).characters,8);assert.equal(m.snapshot(1300).rate,4);
});
test('global incremental scan survives partial lines; settings switch and resume retain the chosen global epoch',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'pulse-scope-'));assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep));t.after(()=>rm(home,{recursive:true,force:true}));const root=path.join(home,'sessions');await mkdir(root);
 const file=path.join(root,`rollout-${a}.jsonl`);await writeFile(file,JSON.stringify(record(Date.now()-10000,a,'old',99,9))+'\n');
 const catalog={roots:[root],entries:[{id:a,file,title:'选择的对话',modifiedAt:Date.now()}],restricted:false,async refresh(){return this.entries;},async active(){return true;},publicList(){return this.entries.map(({id,title})=>({id,title}));}};
 const settingsFile=path.join(home,'runtime','settings.json');const engine=new ScopeEngine({threadId:a,settingsFile,catalog,desktopEnabled:false});t.after(()=>engine.close());await engine.initialize();await engine.tick();assert.equal(engine.snapshot().selectedId,a);
 await engine.select({mode:'all',threadId:a});const since=engine.config.globalStartedAt;await engine.tick();assert.equal(engine.snapshot().usage.total_tokens,0);
 const next=JSON.stringify(record(Date.now()+1,a,'new',120,12));await appendFile(file,next.slice(0,50));await engine.global.tick(catalog.entries,catalog.roots);assert.equal(engine.snapshot().usage.total_tokens,0);
 await appendFile(file,next.slice(50)+'\n');await engine.global.tick(catalog.entries,catalog.roots);assert.equal(engine.snapshot().usage.total_tokens,120);assert.equal(engine.snapshot().selectedId,null);
 await engine.select({mode:'thread',threadId:a});await engine.select({mode:'all',threadId:a});assert.equal(engine.config.globalStartedAt,since);await engine.tick();assert.equal(engine.snapshot().usage.total_tokens,120);
 const saved=JSON.parse(await readFile(settingsFile,'utf8'));assert.equal(saved.mode,'all');assert.equal(saved.globalStartedAt,since);
 const resumed=new ScopeEngine({threadId:b,settingsFile,catalog,desktopEnabled:false});t.after(()=>resumed.close());await resumed.initialize();assert.equal(resumed.config.mode,'all');assert.equal(resumed.config.globalStartedAt,since);
});

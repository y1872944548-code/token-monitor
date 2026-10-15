import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { DesktopMetrics, DesktopEvents } from '../src/desktop-events.mjs';
const itemPath=['turnHistory','history','entitiesByKey','turn','items',0];
const snapshot={type:'snapshot',revision:1,conversationState:{latestTokenUsageInfo:{total:{totalTokens:100,inputTokens:90,outputTokens:10}},turnHistory:{history:{entitiesByKey:{turn:{status:'inProgress',items:[{type:'agentMessage',id:'a',text:'past private text'}]}}}}}};
test('replayed shorter text does not count the same characters again',()=>{
  const metrics=new DesktopMetrics();metrics.accept(snapshot,1000);
  let revision=1;
  const replace=text=>metrics.accept({type:'patches',baseRevision:revision,revision:++revision,patches:[{op:'replace',path:[...itemPath,'text'],value:text}]},1100+revision);
  replace('past private text plus');assert.equal(metrics.snapshot(1200).characters,5);
  replace('past');replace('past private text plus');
  assert.equal(metrics.snapshot(1300).characters,5,'replayed ranges must not inflate visible speed');
  replace('past private text plus!');assert.equal(metrics.snapshot(1400).characters,6);
});
test('desktop revision must advance before accepting more text',()=>{
  for(const revision of [0,1]){
    const metrics=new DesktopMetrics();metrics.accept(snapshot,1000);
    assert.equal(metrics.accept({type:'patches',baseRevision:1,revision,patches:[{op:'replace',path:[...itemPath,'text'],value:'past private text extra'}]},1100),false);
    assert.equal(metrics.snapshot(1200).characters,0);
    assert.equal(metrics.synced,false);
  }
});
test('desktop counters ignore history/reasoning, count Unicode visible deltas, reject revision gaps',()=>{
  const metrics=new DesktopMetrics();assert.equal(metrics.accept(snapshot,1000),true);assert.equal(metrics.snapshot(1000).characters,0);
  metrics.accept({type:'patches',baseRevision:1,revision:2,patches:[{op:'add',path:[...itemPath.slice(0,-1),1],value:{type:'reasoning',id:'r',content:'private reasoning'}}]},1100);
  assert.equal(metrics.snapshot(1100).characters,0);
  metrics.accept({type:'patches',baseRevision:2,revision:3,patches:[{op:'add',path:[...itemPath.slice(0,-1),2],value:{type:'agentMessage',id:'b',text:'你好😀'}}]},1200);
  assert.equal(metrics.snapshot(1200).characters,3);
  metrics.accept({type:'patches',baseRevision:3,revision:4,patches:[{op:'replace',path:[...itemPath.slice(0,-1),2,'text'],value:'你好😀继续'}]},1300);
  assert.equal(metrics.snapshot(1300).characters,5);assert.equal(metrics.snapshot(1300).rate,2.5);
  assert.equal(JSON.stringify(metrics.snapshot(1300)).includes('private'),false);assert.equal(JSON.stringify([...metrics.lengths]).includes('你好'),false);
  metrics.accept({type:'patches',baseRevision:4,revision:5,patches:[{op:'replace',path:['latestTokenUsageInfo'],value:{total:{totalTokens:120,outputTokens:15,inputTokens:105}}}]},1400);
  assert.equal(metrics.snapshot(1400).officialObservedAt,1400);assert.equal(metrics.snapshot(1400).officialUsage.total_tokens,120);
  assert.equal(metrics.snapshot(4000).rate,0,'silence is zero visible text throughput, not zero token consumption');
  assert.equal(metrics.accept({type:'patches',baseRevision:99,revision:100,patches:[]},4100),false);assert.equal(metrics.synced,false);
});
test('desktop IPC observes only its thread and uses no generation or mutation requests',async t=>{
  const endpoint=process.platform==='win32'?`\\\\.\\pipe\\codex-pulse-test-${randomUUID()}`:`/tmp/pulse-${randomUUID()}.sock`;
  const methods=[],clients=new Set();let currentSocket,send;
  const server=net.createServer(socket=>{
    clients.add(socket);currentSocket=socket;let buffer=Buffer.alloc(0);
    send=message=>{const body=Buffer.from(JSON.stringify(message)),frame=Buffer.alloc(4+body.length);frame.writeUInt32LE(body.length);body.copy(frame,4);socket.write(frame);};
    socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE(0)){const size=buffer.readUInt32LE(0),message=JSON.parse(buffer.subarray(4,4+size));buffer=buffer.subarray(4+size);methods.push(message.method);
      if(message.method==='initialize')send({type:'response',requestId:message.requestId,resultType:'success',result:{clientId:'observer'}});
      if(message.method==='thread-owner-discovery')send({type:'response',requestId:message.requestId,resultType:'success',handledByClientId:'owner'});
      if(message.method==='thread-stream-following-changed'&&message.params.following)send({type:'broadcast',method:'thread-stream-state-changed',version:11,params:{conversationId:'selected',change:snapshot}});
    }});socket.on('close',()=>clients.delete(socket));
  });
  await new Promise(resolve=>server.listen(endpoint,resolve));
  const source=new DesktopEvents({threadId:'selected',endpoint,reconnectMs:20});t.after(()=>{source.stop();for(const socket of clients)socket.destroy();server.close();});source.start();
  const wait=async fn=>{const end=Date.now()+2000;while(!fn()){assert.ok(Date.now()<end,'desktop handshake timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
  await wait(()=>source.snapshot().synchronized);
  send({type:'broadcast',method:'thread-stream-state-changed',version:11,params:{conversationId:'other',change:{type:'patches',baseRevision:1,revision:2,patches:[{op:'add',path:itemPath,value:{type:'agentMessage',id:'foreign',text:'private foreign'}}]}}});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(source.snapshot().characters,0);assert.equal(source.snapshot().revision,1);
  send({type:'broadcast',method:'thread-stream-state-changed',version:11,params:{conversationId:'selected',change:{type:'patches',baseRevision:1,revision:2,patches:[{op:'add',path:[...itemPath.slice(0,-1),1],value:{type:'agentMessage',id:'new',text:'fresh'}}]}}});
  await wait(()=>source.snapshot().characters===5);assert.ok(methods.every(name=>['initialize','thread-owner-discovery','thread-stream-following-changed'].includes(name)));
  currentSocket.destroy();await wait(()=>!source.snapshot().connected);source.stop();
});

import {createInterface} from 'node:readline';
import {ScopeEngine} from './scope-engine.mjs';
import {isId} from './thread-catalog.mjs';
import {clientId,clientSettingsFile} from './clients.mjs';
import {ClientMonitor} from './client-monitor.mjs';
const index=process.argv.indexOf('--thread'),id=process.argv[index+1];if(index<0||!isId(id))throw new Error('需要明确的聊天ID');
const client=clientId();
const settingsFile=clientSettingsFile(client);
let busy=false,queued=false,scheduled,enabled=true,pendingScope,includeCatalog=true;
function schedule(delay=50){if(!enabled||scheduled)return;scheduled=setTimeout(()=>{scheduled=null;void sample();},delay);}
const engine=client==='codex'?new ScopeEngine({threadId:id,settingsFile,onChange:()=>schedule(100)}):new ClientMonitor({client,threadId:id,settingsFile});await engine.initialize();
// Explicit streaming launches follow this session without replacing the saved
// default scope. User scope changes during the run still persist normally.
if(client==='claude-code'&&process.argv.includes('--follow-thread'))engine.config={...engine.config,mode:'thread',threadId:id};
async function sample(){if(!enabled)return;if(busy){queued=true;return;}busy=true;
  try{if(pendingScope){const request=pendingScope;pendingScope=null;try{await engine.select(request);}catch(error){engine.controlError=error.message;}}
    await engine.tick();const value=engine.snapshot();value.points=value.points.slice(-250).map(({time,rate})=>({time,rate}));value.reportedPoints=value.reportedPoints.slice(-250).map(({time,rate})=>({time,rate}));delete value.tokenPoints;delete value.sessions;
    if(includeCatalog){value.catalog=engine.catalog.publicList();value.catalogRestricted=engine.catalog.restricted;includeCatalog=false;}
    process.stdout.write(JSON.stringify(value)+'\n');
  }catch(error){process.stderr.write('Scope sample failed: '+error.message+'\n');}
  finally{busy=false;if(queued){queued=false;schedule(0);}}
}
await sample();const timer=setInterval(sample,500),controls=createInterface({input:process.stdin});
controls.on('line',line=>{if(line==='pause'){enabled=false;clearTimeout(scheduled);scheduled=null;engine.pause();}else if(line==='resume'){enabled=true;engine.resume();void sample();}else if(line==='list'){includeCatalog=true;engine.catalog.lastRefresh=0;schedule(0);}else{try{const request=JSON.parse(line);if(request.type==='scope'){pendingScope=request;includeCatalog=true;schedule(0);}}catch{engine.controlError='设置格式无效';}}});
function shutdown(){enabled=false;clearInterval(timer);clearTimeout(scheduled);engine.close();process.exit(0);}
controls.on('close',shutdown);
process.on('SIGTERM',shutdown);

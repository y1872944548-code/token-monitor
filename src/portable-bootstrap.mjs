import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ThreadCatalog,isId} from './thread-catalog.mjs';
import {clientId,clientDataDir,clientSettingsFile} from './clients.mjs';
import {ClientMonitor} from './client-monitor.mjs';

const client=clientId(),data=clientDataDir(client);
await mkdir(data,{recursive:true});
let catalog;
if(client==='codex'){catalog=new ThreadCatalog();await catalog.refresh(true);}
else{const monitor=new ClientMonitor({client});await monitor.initialize();catalog=monitor.catalog;monitor.close();}
const settingsFile=clientSettingsFile(client);let settings;
try{settings=JSON.parse(await readFile(settingsFile,'utf8'));if(!isId(settings.threadId)||!['all','thread'].includes(settings.mode))throw new Error('Invalid saved monitor settings');}
catch(error){if(error.code!=='ENOENT')throw error;settings={mode:'all',threadId:catalog.entries[0]?.id??randomUUID(),globalStartedAt:Date.now()};await writeFile(settingsFile,JSON.stringify(settings,null,2)+'\n');}
// Report only bootstrap metadata, never titles, message bodies or credentials.
process.stdout.write(JSON.stringify({client,threadId:settings.threadId,mode:settings.mode,node:process.version,indexAvailable:!catalog.restricted,localThreads:catalog.entries.length}));

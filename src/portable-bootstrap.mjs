import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ThreadCatalog,isId} from './thread-catalog.mjs';

const data=process.env.CODEX_PULSE_DATA_DIR||fileURLToPath(new URL('../runtime/',import.meta.url));
await mkdir(data,{recursive:true});
const catalog=new ThreadCatalog();await catalog.refresh(true);
const settingsFile=process.env.CODEX_PULSE_SETTINGS_FILE||path.join(data,'monitor-settings.json');let settings;
try{settings=JSON.parse(await readFile(settingsFile,'utf8'));if(!isId(settings.threadId)||!['all','thread'].includes(settings.mode))throw new Error('Invalid saved monitor settings');}
catch(error){if(error.code!=='ENOENT')throw error;settings={mode:'all',threadId:catalog.entries[0]?.id??randomUUID(),globalStartedAt:Date.now()};await writeFile(settingsFile,JSON.stringify(settings,null,2)+'\n');}
// Report only bootstrap metadata, never titles, message bodies or credentials.
process.stdout.write(JSON.stringify({threadId:settings.threadId,mode:settings.mode,node:process.version,indexAvailable:!catalog.restricted,localThreads:catalog.entries.length}));

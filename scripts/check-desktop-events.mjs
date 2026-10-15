import { DesktopEvents } from '../src/desktop-events.mjs';
import { writeFile } from 'node:fs/promises';
const source=new DesktopEvents({threadId:process.argv[2]??process.env.CODEX_THREAD_ID});const samples=[];source.start();
const timer=setInterval(()=>{const {points,officialUsage,...sample}=source.snapshot();samples.push({at:Date.now(),...sample,totalTokens:officialUsage?.total_tokens??null});if(samples.length<=3||sample.rate>0)console.log(JSON.stringify(samples.at(-1)));},500);
setTimeout(async()=>{clearInterval(timer);source.stop();await writeFile(new URL('../QA/desktop-stream-counters-20261015.json',import.meta.url),JSON.stringify({samples,contentStored:false,modelRequests:0},null,2)+'\n');},45000);

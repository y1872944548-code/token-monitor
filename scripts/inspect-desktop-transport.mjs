// Read installed application metadata and selected bundled source only; never execute it.
import { open, writeFile } from 'node:fs/promises';
const archive='C:/Program Files/WindowsApps/OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0/app/resources/app.asar';
const handle=await open(archive,'r');
try {
  const prefix=Buffer.alloc(16);await handle.read(prefix,0,16,0);
  const headerBytes=prefix.readUInt32LE(4),jsonBytes=prefix.readUInt32LE(12);
  if(headerBytes>16000000||jsonBytes>headerBytes||jsonBytes<2)throw new Error('Unexpected archive header');
  const buffer=Buffer.alloc(jsonBytes);await handle.read(buffer,0,jsonBytes,16);const header=JSON.parse(buffer.toString('utf8'));
  const files=[];function walk(tree,base=''){for(const [name,entry]of Object.entries(tree.files??{})){const key=base+name;if(entry.files)walk(entry,key+'/');else files.push({name:key,...entry});}}walk(header);
  async function content(file){if(file.unpacked||file.size>16000000)return '';const data=Buffer.alloc(file.size);await handle.read(data,0,data.length,8+headerBytes+Number(file.offset));return data.toString('utf8');}
  if(process.argv.includes('--focus')) {
    const source=await content(files.find(f=>f.name.includes('application-network-startup-')));
    console.log(source.slice(262900,265200));
    console.log(source.slice(270500,277500));
  }
  if(process.argv.includes('--ipc')) {
    const excerpts=[];
    for(const file of files.filter(f=>f.name.startsWith('.vite/build/')&&f.name.endsWith('.js')&&f.size<16000000)){
      const source=await content(file);const terms=/thread-stream-following-status-requested|thread-stream-following-changed|app-server-notification|app-server-request|ipc-client-hello|connectionType/g;let m;
      while((m=terms.exec(source))){excerpts.push({file:file.name,offset:m.index,context:source.slice(Math.max(0,m.index-300),m.index+900)});if(excerpts.length>=45)break;}if(excerpts.length>=45)break;
    }
    await writeFile(new URL('../QA/desktop-ipc-excerpts-20261015.json',import.meta.url),JSON.stringify(excerpts,null,2)+'\n');console.log(JSON.stringify(excerpts));
  }
  const query=process.argv.find(arg=>arg.startsWith('--find='))?.slice(7);
  const section=process.argv.find(arg=>arg.startsWith('--section='))?.slice(10);
  if(section){const [prefix,start,end]=section.split(':');const file=files.find(f=>f.name.startsWith('.vite/build/'+prefix)&&f.name.endsWith('.js'));if(!file)throw new Error('Section file not found');const source=await content(file);console.log(source.slice(Number(start),Math.min(Number(end),Number(start)+18000)));}
  if(query) {
    const excerpts=[];
    for(const file of files.filter(f=>f.name.startsWith('.vite/build/')&&/\/(?:src-|main-|application-network)/.test(f.name)&&f.size<16000000)){
      const source=await content(file);let start=0;
      while((start=source.indexOf(query,start))>=0){excerpts.push({file:file.name,offset:start,context:source.slice(Math.max(0,start-300),start+1400)});start+=query.length;if(excerpts.length>=16)break;}if(excerpts.length>=16)break;
    }
    console.log(JSON.stringify(excerpts));
  }
  const pkg=JSON.parse(await content(files.find(f=>f.name==='package.json')));console.log(JSON.stringify({version:pkg.version,main:pkg.main,files:files.filter(f=>/main|ipc|app.server/i.test(f.name)&&/\.(js|cjs|mjs)$/.test(f.name)).map(f=>({name:f.name,size:f.size})).slice(0,35)}));
  const pattern=/codex-ipc|app-server-control|CODEX_[A-Z_]*(?:APP_SERVER|BINARY)[A-Z_]*|appServerBinary|appServerPath|app-server(?:.{0,80}--listen)|--listen.{0,100}/g;
  const matches=[];for(const file of files.filter(f=>/\.(?:js|cjs|mjs)$/.test(f.name)&&!f.name.includes('node_modules/')&&f.size<=16000000)){
    const source=await content(file);let match;while((match=pattern.exec(source))){matches.push({file:file.name,offset:match.index,context:source.slice(Math.max(0,match.index-180),match.index+260)});if(matches.length>=100)break;}if(matches.length>=100)break;
  }
  await writeFile(new URL('../QA/desktop-transport-source-20261015.json',import.meta.url),JSON.stringify({archive,version:pkg.version,matches},null,2)+'\n');if(!process.argv.includes('--focus')&&!process.argv.includes('--ipc')&&!query&&!section)console.log(JSON.stringify(matches.slice(0,22)));
} finally {await handle.close();}

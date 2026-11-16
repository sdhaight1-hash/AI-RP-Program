// Portable, dependency-free ZIP (stored entries) for a single universe.
// Contents are an atomic SQLite snapshot plus that world's external assets.
// Reject symlink traversal; never gather assets from another world directory.
import {open,readdir,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const U32=0xffffffff;
const CATEGORIES=['portraits','locations','maps','generated-images'];
const CRC_TABLE=Uint32Array.from({length:256},(_,index)=>{
  let crc=index;
  for(let j=0;j<8;j++)crc=(crc&1)?(0xedb88320^(crc>>>1)):(crc>>>1);
  return crc>>>0;
});
export function crc32(bytes){
  return (updateCrc(0xffffffff,bytes)^0xffffffff)>>>0;
}
function updateCrc(seed,bytes){
  let crc=seed;
  for(const value of bytes)crc=(CRC_TABLE[(crc^value)&255]^(crc>>>8))>>>0;
  return crc;
}
async function collectFiles(folder,prefix,files){
  let stat;
  try{stat=await lstat(folder);}
  catch(error){if(error.code==='ENOENT')return;throw error;}
  if(stat.isSymbolicLink())throw Error('Refusing to export linked asset path');
  if(stat.isFile()){
    files.push({name:prefix.replaceAll('\\','/'),source:folder});
    return;
  }
  if(!stat.isDirectory())throw Error('Unsupported universe asset path');
  const names=(await readdir(folder)).sort();
  for(const name of names){
    if(name==='.'||name==='..'||name.includes('/')||name.includes('\\'))
      throw Error('Invalid universe asset path');
    await collectFiles(join(folder,name),prefix+'/'+name,files);
  }
}
export async function makeUniverseZip({worldId,snapshotPath,worldFolder,outputPath}){
  if(typeof worldId!=='string'||!worldId||!snapshotPath||!worldFolder||!outputPath)
    throw Error('Invalid universe export request');
  const sources=[{name:'world.sqlite',source:snapshotPath}];
  for(const category of CATEGORIES)
    await collectFiles(join(worldFolder,category),'assets/'+category,sources);
  if(sources.length>65534)throw Error('Too many files for a single ZIP export');
  const file=await open(outputPath,'wx');
  let position=0;
  const records=[],manifestFiles=[];
  const write=async buffer=>{
    let offset=0;
    while(offset<buffer.length){
      const result=await file.write(buffer,offset,buffer.length-offset,position);
      if(!result.bytesWritten)throw Error('Could not finish writing universe archive');
      position+=result.bytesWritten;offset+=result.bytesWritten;
    }
  };
  const insert=async({name,source,buffer})=>{
    const label=Buffer.from(name,'utf8'),start=position;
    if(label.length>65535||start>U32)throw Error('Universe ZIP path or archive too large');
    const header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0); // local header
    header.writeUInt16LE(20,4);
    header.writeUInt16LE(0x0808,6); // streaming descriptor + UTF-8
    header.writeUInt16LE(label.length,26);
    await write(header);await write(label);
    let hash=createHash('sha256'),crc=0xffffffff,size=0;
    async function addChunk(chunk){
      size+=chunk.length;
      if(size>U32)throw Error('Individual file exceeds ZIP 4 GB limit');
      hash.update(chunk);crc=updateCrc(crc,chunk);await write(chunk);
    }
    if(buffer)await addChunk(buffer);
    else for await(const chunk of createReadStream(source,{highWaterMark:256*1024}))
      await addChunk(chunk);
    crc=(crc^0xffffffff)>>>0;
    const descriptor=Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50,0);
    descriptor.writeUInt32LE(crc,4);
    descriptor.writeUInt32LE(size,8);
    descriptor.writeUInt32LE(size,12);
    await write(descriptor);
    records.push({label,start,crc,size});
    return {path:name,bytes:size,sha256:hash.digest('hex')};
  };
  try{
    for(const source of sources)manifestFiles.push(await insert(source));
    const manifest=Buffer.from(JSON.stringify({
      format:'ai-rp-universe-archive-v1',worldId,
      exportedAt:new Date().toISOString(),
      content:'SQLite canon/story/gallery BLOBs plus world-local external asset directories',
      restoreNote:'A future in-app import is not available. The archive preserves world.sqlite and assets for manual recovery.',
      files:manifestFiles
    },null,2),'utf8');
    await insert({name:'manifest.json',buffer:manifest});
    const centralStart=position;
    for(const record of records){
      const header=Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50,0);
      header.writeUInt16LE(20,4);header.writeUInt16LE(20,6);
      header.writeUInt16LE(0x0808,8);
      header.writeUInt32LE(record.crc,16);
      header.writeUInt32LE(record.size,20);
      header.writeUInt32LE(record.size,24);
      header.writeUInt16LE(record.label.length,28);
      header.writeUInt32LE(record.start,42);
      await write(header);await write(record.label);
    }
    const centralSize=position-centralStart;
    if(position>U32||centralStart>U32||centralSize>U32)
      throw Error('Universe ZIP is too large; use SQLite backup plus separate asset folders');
    const end=Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50,0);
    end.writeUInt16LE(records.length,8);
    end.writeUInt16LE(records.length,10);
    end.writeUInt32LE(centralSize,12);
    end.writeUInt32LE(centralStart,16);
    await write(end);
    return {worldId,entries:records.length,bytes:position};
  }finally{await file.close();}
}

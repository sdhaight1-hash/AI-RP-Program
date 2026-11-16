// Shared, explicit universe-entry gallery. Binary photo bytes are fetched
// separately from the catalog and never included in model prompts.
export function mountEntryPhotoGallery(host,{
  worldId,entryType,entryId,entryName,photos=[],fetchImpl=fetch,
  refreshWorldLibrary,showError
}){
  const attached=photos.filter(x=>x.worldId===worldId&&x.entryType===entryType&&x.entryId===entryId);
  const root=document.createElement('details');
  root.className='entry-photo-gallery';
  root.setAttribute('aria-label','Photos of '+entryName);
  root.open=attached.length>0;
  const header=document.createElement('summary');header.className='entry-photo-gallery-heading';
  const heading=document.createElement('strong');heading.textContent='Photos & visual references';
  const count=document.createElement('small');count.textContent=String(attached.length)+' images';
  header.append(heading,count);root.append(header);
  const gallery=document.createElement('div');gallery.className='entry-photo-grid';
  for(const photo of attached){
    const item=document.createElement('figure');item.className='entry-photo-item';
    const link=document.createElement('a');
    const uri='/api/worlds/photos/'+encodeURIComponent(photo.id)+'?worldId='+encodeURIComponent(worldId);
    link.href=uri;link.target='_blank';link.rel='noopener noreferrer';
    link.title='View full-size photo';
    const img=document.createElement('img');img.src=uri;img.loading='lazy';
    img.alt=photo.caption||'Visual reference for '+entryName;
    link.append(img);item.append(link);
    const caption=document.createElement('figcaption');caption.textContent=photo.caption||'Untitled image';
    item.append(caption);
    const actions=document.createElement('div');actions.className='entry-photo-actions';
    const edit=document.createElement('button');edit.type='button';edit.textContent='Edit caption';
    edit.className='subtle-button';
    edit.onclick=async()=>{
      const value=window.prompt('Photo caption (up to 2,000 characters)',photo.caption||'');
      if(value===null)return;
      edit.disabled=true;
      try{
        const response=await fetchImpl('/api/worlds/photos',{method:'PATCH',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({worldId,id:photo.id,caption:value})});
        const data=await response.json();
        if(!response.ok)throw Error(data.error||'Cannot update caption');
        await refreshWorldLibrary();showError();
      }catch(error){showError(error.message);edit.disabled=false;}
    };
    const remove=document.createElement('button');remove.type='button';
    remove.textContent='Remove photo';remove.className='mini-action';
    remove.onclick=async()=>{
      if(!window.confirm('Permanently remove this photo from '+entryName+'?'))return;
      remove.disabled=true;
      try{
        const response=await fetchImpl('/api/worlds/photos',{method:'DELETE',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({worldId,id:photo.id})});
        const data=await response.json();
        if(!response.ok)throw Error(data.error||'Cannot remove photo');
        await refreshWorldLibrary();showError();
      }catch(error){showError(error.message);remove.disabled=false;}
    };
    actions.append(edit,remove);item.append(actions);gallery.append(item);
  }
  root.append(gallery);
  const compose=document.createElement('div');compose.className='entry-photo-upload';
  const caption=document.createElement('input');caption.type='text';caption.maxLength=2000;
  caption.placeholder='Optional image caption or description';
  caption.setAttribute('aria-label','Caption for uploaded photos');
  const input=document.createElement('input');input.type='file';input.multiple=true;
  input.accept='image/jpeg,image/png,image/webp';
  input.setAttribute('aria-label','Choose photos for '+entryName);
  const button=document.createElement('button');button.type='button';
  button.className='subtle-button';button.textContent='Add selected photos';
  const status=document.createElement('span');status.className='help';status.setAttribute('role','status');
  button.onclick=async()=>{
    const files=[...input.files||[]];
    if(!files.length){status.textContent='Choose one or more photos first.';return;}
    button.disabled=true;input.disabled=true;
    let done=0;
    try{
      for(const file of files){
        if(!['image/jpeg','image/png','image/webp'].includes(file.type)||
          file.size>12_000_000||file.size<16)
          throw Error('Each photo must be a PNG, JPEG or WebP up to 12 MB');
        status.textContent='Adding photo '+(done+1)+' of '+files.length+'…';
        const params=new URLSearchParams({
          worldId,entryType,entryId,caption:caption.value
        });
        const response=await fetchImpl('/api/worlds/photos?'+params,{
          method:'POST',headers:{'Content-Type':file.type},body:file
        });
        const data=await response.json();
        if(!response.ok)throw Error(data.error||'Could not upload '+file.name);
        done++;
      }
      status.textContent=done+' photos added.';
      input.value='';caption.value='';
      await refreshWorldLibrary();showError();
    }catch(error){
      status.textContent=done+' uploaded; '+error.message;
      showError(error.message);button.disabled=false;input.disabled=false;
      if(done)await refreshWorldLibrary();
    }
  };
  compose.append(caption,input,button,status);root.append(compose);host.append(root);
  return root;
}

// Decode one OpenAI-compatible SSE stream to bind the final completion
// ticket to exactly the bytes of the model's visible reply. A stream that
// errors or does not finish with [DONE] never produces a usable ticket.
export function createReplyStreamReader(){
  let buffer='',text='',done=false,error=null;
  const frame=source=>{
    const rows=source.split('\n');
    const data=rows.filter(line=>line.startsWith('data:'))
      .map(line=>line.slice(5).trimStart()).join('\n');
    if(!data)return;
    if(data==='[DONE]'){done=true;return;}
    if(done)return;
    try{
      const event=JSON.parse(data);
      if(event.error){error=typeof event.error==='string'?event.error:JSON.stringify(event.error);return;}
      const delta=event.choices?.[0]?.delta?.content;
      if(typeof delta==='string'){
        text+=delta;
        if(text.length>30000)error='Model response exceeded 30000 characters';
      }
    }catch{error='Malformed local model stream frame';}
  };
  return {
    feed(chunk){
      buffer+=(typeof chunk==='string'?chunk:new TextDecoder().decode(chunk)).replace(/\r\n/g,'\n');
      const parts=buffer.split('\n\n');
      buffer=parts.pop()||'';
      for(const part of parts)frame(part);
    },
    get text(){return text;},
    get done(){return done;},
    get error(){return error;},
    completed(){return done&&!error&&Boolean(text.trim());}
  };
}

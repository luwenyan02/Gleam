"""Synthetic native pull bridge, backed only by existing .invalid fetch fixtures."""

MOCK = r''';(() => {
 const original=window.Capacitor.nativePromise, sessions=new Map(), cancelled=new Set();
 window.__aiStreamCalls=[];
 window.Capacitor.PluginHeaders.push({name:'GleamAiStream',methods:['start','read','cancel'].map(name=>({name,rtype:'promise'}))});
 window.Capacitor.nativePromise=async(plugin,method,options={})=>{
  if(plugin!=='GleamAiStream')return original(plugin,method,options);
  const id=options.id;window.__aiStreamCalls.push({method,id});
  if(method==='start'){
   const url=new URL(options.url);
   if(url.protocol!=='https:'||!url.hostname.endsWith('.invalid')||url.username||url.password)throw Error('SYNTHETIC_FIXTURE_NETWORK_BLOCKED');
   if(cancelled.delete(id))throw new DOMException('Aborted','AbortError');
   const aborter=new AbortController(),session={aborter,pending:new Uint8Array()};sessions.set(id,session);
   try{
    const transport=window.__nativeAiWireFetch||window.fetch;
    const response=await transport.call(window,options.url,{method:'POST',headers:{Authorization:options.authorization,'Content-Type':'application/json'},body:options.body,signal:aborter.signal});
    if(sessions.get(id)!==session){await response.body?.cancel();throw new DOMException('Aborted','AbortError');}
    if(!response.ok||response.status===204||response.status===205){sessions.delete(id);await response.body?.cancel();}
    else session.reader=response.body.getReader();
    return {status:response.status,contentType:response.headers.get('content-type')||''};
   }catch(error){sessions.delete(id);throw error;}
  }
  if(method==='read'){
   const session=sessions.get(id);if(!session?.reader)throw Error('SYNTHETIC_STREAM_CLOSED');
   if(!session.pending.length){const chunk=await session.reader.read();if(chunk.done){sessions.delete(id);return {done:true};}session.pending=chunk.value;}
   if(sessions.get(id)!==session)throw Error('SYNTHETIC_STREAM_CLOSED');
   const chunk=session.pending.slice(0,8192);session.pending=session.pending.slice(chunk.length);
   return {done:false,dataBase64:btoa(String.fromCharCode(...chunk))};
  }
  if(method==='cancel'){
   const session=sessions.get(id);sessions.delete(id);
   if(session){session.aborter.abort();void session.reader?.cancel().catch(()=>{});}
   else {cancelled.add(id);if(cancelled.size>128)cancelled.delete(cancelled.values().next().value);}
   return {};
  }
  throw Error('SYNTHETIC_UNKNOWN_STREAM_METHOD');
 };
})();'''

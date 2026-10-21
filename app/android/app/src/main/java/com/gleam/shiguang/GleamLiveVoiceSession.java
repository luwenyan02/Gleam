package com.gleam.shiguang;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import okio.ByteString;

/** Duplex VAD conversation. No Android APIs, credentials, files or existing chat history. */
final class GleamLiveVoiceSession {
    interface Audio {
        void start() throws Exception; default void start(Runnable ready) throws Exception { start(); ready.run(); }
        void stop(); void play(byte[] bytes); default Runnable preparePlay(byte[] bytes) { return ()->play(bytes); } void clear();
        void mute(boolean value); void finish(); boolean playing();
    }
    interface Listener { void ready(); void state(String value); void transcript(List<Turn> turns); void ended(String reason); default void flush() {} }
    static final class Turn {
        final String id, role, text; final long order; final boolean complete; final JSONObject search;
        Turn(String id,String role,String text,boolean complete,JSONObject search,long order) { this.order=order;this.id=id;this.role=role;this.text=text;this.complete=complete;this.search=search; }
    }
    private final GleamSpeechSession.Transport transport;
    private final Audio audio;
    private final Listener listener;
    private final GleamSpeechSession.Clock clock;
    private final String instructions;
    private final LinkedHashMap<String,Turn> turns=new LinkedHashMap<>(), dirty=new LinkedHashMap<>();
    private final LinkedHashMap<String,Long> orders=new LinkedHashMap<>();
    private long nextOrder;
    private static final int MAX_TURN_CHARS=128*1024, RECENT_TURNS=32;
    private final LinkedHashSet<String> blocked=new LinkedHashSet<>(), seen=new LinkedHashSet<>(), finalized=new LinkedHashSet<>();
    private final LinkedHashSet<String> responseItems=new LinkedHashSet<>();
    private GleamSpeechSession.Timer deadline, duration;
    private boolean begun, configuring, ready, closed, muted, responding, responseFinished, responseSucceeded, completionPublished, cancelPending;
    private String serverId, responseId;
    GleamLiveVoiceSession(GleamSpeechSession.Transport transport,Audio audio,Listener listener,GleamSpeechSession.Clock clock,String instructions) {
        this.transport=transport;this.audio=audio;this.listener=listener;this.clock=clock;this.instructions=instructions;
    }
    synchronized boolean closed() { return closed; }
    synchronized void begin() {
        if(begun||closed)return;begun=true;listener.state("connecting");
        deadline=clock.after(30000,()->{ synchronized(this){if(!ready)end("LIVE_TIMEOUT");} });
    }
    private boolean send(String text) {
        if(closed)return false;
        if(!transport.send(text)){end("LIVE_NETWORK");return false;}return true;
    }
    synchronized void pcm(byte[] bytes,int length) {
        if(!ready||closed||muted)return;
        if(length<=0||length>3200||length>bytes.length||length%2!=0){end("LIVE_AUDIO");return;}
        send("{\"type\":\"input_audio_buffer.append\",\"audio\":\""+ByteString.of(bytes,0,length).base64()+"\"}");
    }
    private static JSONObject object(JSONObject parent,String name) { return parent==null?null:parent.optJSONObject(name); }
    private static boolean format(JSONObject value,int rate) {
        if(value==null||!"pcm".equals(value.opt("type"))||!(value.opt("sample_rate") instanceof Number)||value.optInt("sample_rate")!=rate)return false;
        return (!value.has("channels")||Integer.valueOf(1).equals(value.opt("channels")))
            &&(!value.has("sample_format")||"s16le".equals(value.opt("sample_format")))
            &&(!value.has("packing")||"interleaved".equals(value.opt("packing")))
            &&(!value.has("channel_layout")||"mono".equals(value.opt("channel_layout")));
    }
    private boolean safeAck(JSONObject session) {
        if(session==null||(session.has("model")&&!GleamSpeechTransport.MODEL.equals(session.opt("model")))
            ||(serverId!=null&&!serverId.equals(session.opt("id"))))return false;
        JSONArray modalities=session.optJSONArray("modalities"),tools=session.optJSONArray("tools");
        if(modalities==null||modalities.length()!=2||!("text".equals(modalities.opt(0))&&"audio".equals(modalities.opt(1))||"audio".equals(modalities.opt(0))&&"text".equals(modalities.opt(1))))return false;
        if(session.has("tools")&&(tools==null||tools.length()!=0))return false;
        if(!Boolean.TRUE.equals(session.opt("enable_search")))return false;
        JSONObject vad=session.optJSONObject("turn_detection"),config=session.optJSONObject("audio");
        return vad!=null&&"server_vad".equals(vad.opt("type"))
            &&format(object(object(config,"input"),"format"),16000)&&format(object(object(config,"output"),"format"),24000);
    }
    private String update() throws Exception {
        JSONObject input=new JSONObject().put("type","pcm").put("sample_rate",16000).put("sample_format","s16le").put("channels",1).put("packing","interleaved").put("channel_layout","mono");
        JSONObject output=new JSONObject().put("type","pcm").put("sample_rate",24000);
        JSONObject session=new JSONObject().put("modalities",new JSONArray().put("text").put("audio"))
            .put("audio",new JSONObject().put("input",new JSONObject().put("format",input)).put("output",new JSONObject().put("format",output).put("voice","Tina")))
            .put("input_audio_transcription",new JSONObject().put("model","qwen3-asr-flash-realtime"))
            .put("turn_detection",new JSONObject().put("type","server_vad").put("threshold",0.5).put("prefix_padding_ms",300).put("silence_duration_ms",700))
            .put("enable_search",true).put("search_options",new JSONObject().put("enable_source",true)).put("instructions",instructions);
        return new JSONObject().put("type","session.update").put("session",session).toString();
    }
    private void reserve(String id,String role) throws Exception {
        if(id==null||id.isEmpty()||id.length()>160)return;
        if(!turns.containsKey(id)) {
            Long order=orders.get(id);if(order==null){if(orders.size()>=32768){end("LIVE_PROTOCOL");return;}order=nextOrder++;orders.put(id,order);}
            Turn turn=new Turn(id,role,"",false,"assistant".equals(role)?GleamLiveVoiceSearch.state("enabled"):null,order);
            turns.put(id,turn);dirty.put(id,turn);publish(id);
        }
    }
    private void transcript(String id,String role,String text,boolean complete) throws Exception {
        if(id==null||id.isEmpty()||id.length()>160||text==null||finalized.contains(id))return;
        reserve(id,role);if(closed)return;
        if(text.length()>MAX_TURN_CHARS){end("LIVE_LIMIT");return;}
        if(complete)finalized.add(id);
        turns.put(id,new Turn(id,role,complete?text.trim():text,false,turns.get(id).search,turns.get(id).order));
        if("assistant".equals(role)){responseItems.add(id);if(responseItems.size()>32){end("LIVE_PROTOCOL");return;}}
        dirty.put(id,turns.get(id));publish();
    }
    private void publish() {publish(null);}
    private void publish(String protectedId) {
        if(!dirty.isEmpty()){List<Turn> result=new ArrayList<>(dirty.values());dirty.clear();listener.transcript(result);}
        // JS owns full history. Native retains only recent text and the current response awaiting metadata/drain.
        java.util.Iterator<String> iterator=turns.keySet().iterator();
        while(turns.size()>RECENT_TURNS&&iterator.hasNext()) {
            String id=iterator.next();if(!id.equals(protectedId)&&!responseItems.contains(id))iterator.remove();
        }
    }
    void receive(String raw) {
        Runnable playback;
        synchronized(this){playback=receiveLocked(raw);}
        if(playback!=null)playback.run();
    }
    private Runnable receiveLocked(String raw) {
        Runnable playback=null;
        if(closed||!begun)return null;
        if(raw==null||raw.length()>262144){end("LIVE_PROTOCOL");return null;}
        try {
            JSONObject event=new JSONObject(raw);String type=event.getString("type"),eventId=event.optString("event_id");
            if(!eventId.isEmpty()){if(!seen.add(eventId))return null;if(seen.size()>512)seen.remove(seen.iterator().next());}
            if("session.created".equals(type)) {
                if(configuring||ready){end("LIVE_PROTOCOL");return null;}
                JSONObject session=event.optJSONObject("session");
                if(session!=null&&session.has("model")&&!GleamSpeechTransport.MODEL.equals(session.opt("model"))){end("LIVE_PROTOCOL");return null;}
                serverId=session==null?null:session.optString("id",null);configuring=true;send(update());return null;
            }
            if("session.updated".equals(type)) {
                if(!configuring||ready||!safeAck(event.optJSONObject("session"))){end("LIVE_PROTOCOL");return null;}
                configuring=false;
                deadline.cancel();
                deadline=clock.after(35000,()->{synchronized(this){if(!ready)end("LIVE_AUDIO_ROUTE");}});
                duration=clock.after(7200000,()->end("LIVE_SESSION_LIMIT"));
                try{audio.start(this::audioReady);}catch(SecurityException ignored){end("LIVE_PERMISSION_DENIED");return null;}
                catch(Exception ignored){end("LIVE_AUDIO");return null;}
                return null;
            }
            if("error".equals(type)) {
                JSONObject error=event.optJSONObject("error");String code=error==null?"":error.optString("code");
                if(cancelPending&&"response_cancel_not_active".equals(code)){cancelPending=false;return null;}
                end("LIVE_PROVIDER");return null;
            }
            if(!ready)return null;
            String itemId=event.optString("item_id",null),replyId=event.optString("response_id",null);
            if("input_audio_buffer.speech_started".equals(type)){reserve(itemId,"user");interrupt();listener.state(muted?"muted":"listening");}
            if("input_audio_buffer.committed".equals(type))reserve(itemId,"user");
            if("response.created".equals(type)) {
                JSONObject response=event.optJSONObject("response");if(response==null||response.optString("id").isEmpty()){end("LIVE_PROTOCOL");return null;}
                if(responseId!=null){blockResponse(responseId);audio.clear();}
                responseId=response.getString("id");responding=true;responseFinished=false;responseSucceeded=false;completionPublished=false;responseItems.clear();publish();
            }
            if("response.output_item.added".equals(type)) {
                JSONObject item=event.optJSONObject("item");if(item!=null&&"assistant".equals(item.optString("role")))reserve(item.optString("id"),"assistant");
            }
            boolean current=replyId!=null&&replyId.equals(responseId)&&!blocked.contains(replyId);
            if(("response.audio.delta".equals(type)||"response.output_audio.delta".equals(type))&&current) {
                String encoded=event.getString("delta");ByteString bytes=encoded.length()<=180000?ByteString.decodeBase64(encoded):null;
                if(bytes==null||bytes.size()==0||bytes.size()%2!=0){end("LIVE_PROTOCOL");return null;}
                playback=audio.preparePlay(bytes.toByteArray());listener.state(muted?"muted":"speaking");
            }
            if(event.optInt("content_index",0)==0) {
                if("conversation.item.input_audio_transcription.delta".equals(type))transcript(itemId,"user",event.optString("text","")+event.optString("stash",""),false);
                if("conversation.item.input_audio_transcription.completed".equals(type))transcript(itemId,"user",event.optString("transcript",null),true);
                if(("response.audio_transcript.delta".equals(type)||"response.output_audio_transcript.delta".equals(type))&&current) {
                    Turn previous=turns.get(itemId);String delta=event.optString("delta",null);
                    if(delta!=null)transcript(itemId,"assistant",(previous==null?"":previous.text)+delta,false);
                }
                if(("response.audio_transcript.done".equals(type)||"response.output_audio_transcript.done".equals(type))&&current)transcript(itemId,"assistant",event.optString("transcript",null),true);
            }
            if("response.done".equals(type)) {
                JSONObject response=event.optJSONObject("response");if(response==null)return null;
                if(!response.optString("id").equals(responseId)||blocked.contains(responseId))return null;
                responding=false;responseFinished=true;
                JSONObject search=GleamLiveVoiceSearch.result(response);
                for(String id:responseItems) {
                    Turn turn=turns.get(id);
                    if(turn!=null&&"assistant".equals(turn.role)){turns.put(id,new Turn(id,turn.role,turn.text,turn.complete,search,turn.order));dirty.put(id,turns.get(id));}
                }
                publish();
                if("failed".equals(response.optString("status"))){end("LIVE_PROVIDER");return null;}
                responseSucceeded="completed".equals(response.optString("status"));
                audio.finish();drained();listener.flush();
            }
        } catch(Exception ignored){end("LIVE_PROTOCOL");return null;}
        return playback;
    }
    private synchronized void audioReady() {
        if(closed||ready)return;
        ready=true;deadline.cancel();
        listener.ready();listener.state("listening");
    }
    synchronized void drained() {
        if(closed||!responseFinished||audio.playing())return;
        if(responseSucceeded&&!completionPublished) {
            completionPublished=true;
            for(String id:responseItems) {
                Turn turn=turns.get(id);
                if(turn!=null&&"assistant".equals(turn.role)&&finalized.contains(id)){turns.put(id,new Turn(id,turn.role,turn.text,true,turn.search,turn.order));dirty.put(id,turns.get(id));}
            }
            publish();listener.flush();
        }
        listener.state(muted?"muted":"listening");
    }
    synchronized void mute(boolean value) {
        if(closed||!ready)return;muted=value;audio.mute(value);
        if(value)send("{\"type\":\"input_audio_buffer.clear\"}");listener.state(value?"muted":audio.playing()?"speaking":"listening");
    }
    synchronized void interrupt() {
        if(closed||!ready)return;audio.clear();
        if(responseId!=null)blockResponse(responseId);
        if(responding){cancelPending=true;send("{\"type\":\"response.cancel\"}");}
        responding=false;responseFinished=false;listener.flush();listener.state(muted?"muted":"listening");
    }
    private void blockResponse(String id) { blocked.add(id);if(blocked.size()>128)blocked.remove(blocked.iterator().next()); }
    synchronized void end(String reason) {
        if(closed)return;listener.flush();closed=true;if(deadline!=null)deadline.cancel();if(duration!=null)duration.cancel();
        try{audio.stop();}catch(RuntimeException ignored){}
        try{transport.close();}catch(RuntimeException ignored){}
        listener.ended(reason);
    }
}

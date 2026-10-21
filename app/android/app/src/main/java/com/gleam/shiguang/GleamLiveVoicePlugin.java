package com.gleam.shiguang;

import android.Manifest;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.ArrayList;
import javax.net.ssl.SSLException;
import okhttp3.*;
import okio.ByteString;

/** Reuses only the native, tested speech credential snapshot. No JS keys, URLs or config writes. */
@CapacitorPlugin(name="GleamLiveVoice",permissions={@Permission(alias="microphone",strings={Manifest.permission.RECORD_AUDIO})})
public final class GleamLiveVoicePlugin extends Plugin {
    private final Handler main=new Handler(Looper.getMainLooper());
    private final OkHttpClient client=GleamSpeechTransport.client();
    private final GleamSpeechIdentity identity=new GleamSpeechIdentity();
    private GleamSpeechCredentials credentials;
    private volatile Session active;
    private Session permissionRequest;
    private volatile boolean foreground=true,destroyed;
    private final Runnable credentialsChanged=()->{
        Session session=active;if(session!=null){closeSocket(session);main.post(()->end(session,"LIVE_KEY_CHANGED"));}
    };
    private static final class Session {
        final PluginCall call;final String id,revision,instructions;
        final LinkedHashMap<String,GleamLiveVoiceSession.Turn> pendingTurns=new LinkedHashMap<>();
        Runnable publish;boolean publishScheduled,publishOverflow;int pendingTurnChars;String publishedState;
        volatile WebSocket socket;
        GleamSpeechAuthorization authorization;
        GleamLiveVoiceSession engine;
        GleamSpeechCandidateGate.Config config;
        Runnable permissionTimeout;
        boolean ready;String state="connecting";
        Session(PluginCall call){this.call=call;id=call.getString("sessionId");revision=call.getString("expectedCredentialRevision");instructions=call.getString("instructions","");}
    }
    @Override public void load(){credentials=GleamSpeechCredentials.shared(getContext());GleamCredentialLock.add(credentialsChanged);}
    private void onMain(Runnable work){if(Looper.myLooper()==Looper.getMainLooper())work.run();else main.post(work);}
    @PluginMethod public void configuration(PluginCall call){main.post(()->{
        JSObject result=new JSObject();result.put("ready",credentials.hasKey()&&credentials.activeConfig()!=null);result.put("credentialRevision",credentials.revision());call.resolve(result);
    });}
    @Override @PluginMethod public void requestPermissions(PluginCall call){reject(call,"LIVE_CONSENT");}
    @PluginMethod public void start(PluginCall call){main.post(()->{
        if(destroyed||!foreground){reject(call,"LIVE_INTERRUPTED");return;}
        if(!Boolean.TRUE.equals(call.getBoolean("consent"))||!Boolean.TRUE.equals(call.getBoolean("userInitiated"))){reject(call,"LIVE_CONSENT");return;}
        Session session=new Session(call);
        if(!GleamSpeechTransport.validSessionId(session.id)||identity.isEnded(session.id)||session.instructions.length()>6000){reject(call,"LIVE_SESSION");return;}
        if(active!=null){reject(call,"LIVE_BUSY");return;}
        synchronized(GleamCredentialLock.LOCK){
            if(!credentials.revision().equals(session.revision)){reject(call,"LIVE_KEY_CHANGED");return;}
            session.config=credentials.activeConfig();
            if(!credentials.hasKey()||session.config==null){reject(call,"LIVE_CONFIG");return;}
            try{GleamSpeechTransport.endpoint(session.config.region,session.config.workspace,session.config.model);}catch(RuntimeException ignored){reject(call,"LIVE_CONFIG");return;}
            if(!identity.reserve(session.id,session.revision,credentials.revision())){reject(call,"LIVE_SESSION");return;}
            if(!GleamMicrophoneLease.acquire(session)){identity.end(session.id);reject(call,"LIVE_BUSY");return;}
            active=session;session.authorization=new GleamSpeechAuthorization(GleamCredentialLock.LOCK,()->active==session&&identity.mayContinue(session.id,credentials.revision(),foreground,destroyed));
        }
        if(getPermissionState("microphone")==PermissionState.GRANTED)connect(session);
        else{
            permissionRequest=session;session.permissionTimeout=()->end(session,"LIVE_PERMISSION_DENIED");main.postDelayed(session.permissionTimeout,30000);
            requestPermissionForAlias("microphone",call,"microphonePermission");
        }
    });}
    @PermissionCallback private void microphonePermission(PluginCall call){main.post(()->{
        Session session=permissionRequest;if(session==null||session.call!=call)return;
        permissionRequest=null;main.removeCallbacks(session.permissionTimeout);
        if(active!=session)return;
        if(!foreground||destroyed){end(session,"LIVE_INTERRUPTED");return;}
        if(getPermissionState("microphone")!=PermissionState.GRANTED){end(session,"LIVE_PERMISSION_DENIED");return;}
        connect(session);
    });}
    private void connect(Session session){
        if(active!=session||!session.authorization.allowed()){end(session,"LIVE_INTERRUPTED");return;}
        final String key;
        try{synchronized(GleamCredentialLock.LOCK){if(!session.authorization.allowed())throw new IllegalStateException();key=credentials.readForNativeTransport();}}
        catch(Exception ignored){end(session,"LIVE_CONFIG");return;}
        GleamLiveAudio audio=new GleamLiveAudio(getContext(),session.authorization,new GleamLiveAudio.Sink(){
            public void pcm(byte[] bytes,int length){session.engine.pcm(bytes,length);}
            public void failure(String code){main.post(()->end(session,code));}
            public void failure(String code,java.util.function.BooleanSupplier valid){main.post(()->{synchronized(session.engine){if(active==session&&valid.getAsBoolean())end(session,code);}});}
            public void drained(){main.post(()->{if(active==session)session.engine.drained();});}
        });
        GleamSpeechSession.Transport transport=new GleamSpeechSession.Transport(){
            public boolean send(String text){return session.authorization.send(()->session.socket!=null&&session.socket.queueSize()<=131072&&session.socket.send(text));}
            public void close(){closeSocket(session);}
        };
        GleamLiveVoiceSession.Listener listener=new GleamLiveVoiceSession.Listener(){
            public void ready(){onMain(()->{if(active!=session||!session.authorization.allowed())return;session.ready=true;JSObject value=new JSObject();value.put("sessionId",session.id);session.call.resolve(value);});}
            public void state(String value){
                synchronized(session){if(value.equals(session.state))return;session.state=value;}
                schedulePublish(session);
            }
            public void transcript(List<GleamLiveVoiceSession.Turn> turns){
                synchronized(session){
                    if(session.publishOverflow)return;
                    for(GleamLiveVoiceSession.Turn turn:turns){
                        GleamLiveVoiceSession.Turn prior=session.pendingTurns.get(turn.id);
                        int size=session.pendingTurnChars-(prior==null?0:prior.text.length())+turn.text.length();
                        if(size>2097152||prior==null&&session.pendingTurns.size()>=512){session.publishOverflow=true;main.post(()->end(session,"LIVE_PROTOCOL"));return;}
                        session.pendingTurns.put(turn.id,turn);session.pendingTurnChars=size;
                    }
                }
                schedulePublish(session);
            }
            public void flush(){onMain(()->publish(session,true));}
            public void ended(String reason){onMain(()->finish(session,reason));}
        };
        GleamSpeechSession.Clock clock=(ms,work)->{main.postDelayed(work,ms);return ()->main.removeCallbacks(work);};
        session.publish=()->publish(session);
        session.engine=new GleamLiveVoiceSession(transport,audio,listener,clock,session.instructions);session.engine.begin();
        try{session.authorization.activate(()->session.socket=client.newWebSocket(GleamSpeechTransport.request(session.config.region,session.config.workspace,session.config.model,key),new WebSocketListener(){
            @Override public void onOpen(WebSocket socket,Response response){
                // newWebSocket may invoke callbacks before its return value is assigned.
                synchronized(GleamCredentialLock.LOCK){if(active==session&&session.authorization.allowed()&&session.socket==null)session.socket=socket;}
            }
            @Override public void onMessage(WebSocket socket,String message){
                if(message.length()>262144){closeSocket(session);main.post(()->end(session,"LIVE_PROTOCOL"));return;}
                synchronized(GleamCredentialLock.LOCK){
                    if(active!=session||session.socket!=socket)return;
                    if(!session.authorization.allowed()){main.post(()->end(session,"LIVE_INTERRUPTED"));return;}
                }
                // OkHttp delivers messages serially; parsing/spool append never queues large payloads on main.
                session.engine.receive(message);
            }
            @Override public void onMessage(WebSocket socket,ByteString bytes){closeSocket(session);main.post(()->end(session,"LIVE_PROTOCOL"));}
            @Override public void onClosing(WebSocket socket,int code,String reason){socket.cancel();main.post(()->end(session,"LIVE_NETWORK"));}
            @Override public void onClosed(WebSocket socket,int code,String reason){main.post(()->end(session,"LIVE_NETWORK"));}
            @Override public void onFailure(WebSocket socket,Throwable error,Response response){
                String code=error instanceof SSLException?"LIVE_TLS":response!=null&&(response.code()==401||response.code()==403)?"LIVE_AUTH":response!=null&&response.code()==429?"LIVE_RATE_LIMIT":"LIVE_NETWORK";
                if(response!=null&&response.body()!=null)response.body().close();main.post(()->end(session,code));
            }
        }));}catch(RuntimeException ignored){end(session,"LIVE_NETWORK");}
    }
    private void schedulePublish(Session session){
        synchronized(session){if(session.publishScheduled)return;session.publishScheduled=true;}
        main.postDelayed(session.publish,100);
    }
    private void publish(Session session){publish(session,false);}
    private void publish(Session session,boolean finalTranscript){
        if(session.publish!=null)main.removeCallbacks(session.publish);
        List<GleamLiveVoiceSession.Turn> turns;String state;
        synchronized(session){session.publishScheduled=false;turns=new ArrayList<>(session.pendingTurns.values());session.pendingTurns.clear();session.pendingTurnChars=0;state=session.state;}
        if(active!=session)return;
        if(turns.isEmpty()) {
            if(!state.equals(session.publishedState)){session.publishedState=state;event(session,state,null,null);}return;
        }
        JSArray messages=new JSArray();int chars=0;
        for(GleamLiveVoiceSession.Turn turn:turns){
            if(messages.length()>=32||chars+turn.text.length()>262144){event(session,state,messages,null,finalTranscript);messages=new JSArray();chars=0;}
            JSObject message=new JSObject();message.put("id",turn.id);message.put("order",turn.order);message.put("role",turn.role);message.put("content",turn.text);message.put("complete",turn.complete);if(turn.search!=null)message.put("search",turn.search);messages.put(message);chars+=turn.text.length();
        }
        session.publishedState=state;if(messages.length()>0)event(session,state,messages,null,finalTranscript);
    }
    private void event(Session session,String state,JSArray messages,String reason){event(session,state,messages,reason,false);}
    private void event(Session session,String state,JSArray messages,String reason,boolean finalTranscript){
        JSObject value=new JSObject();value.put("sessionId",session.id);value.put("state",state);
        if(messages!=null){value.put("messages",messages);value.put("transcriptMode","upsert");if(finalTranscript)value.put("finalTranscript",true);}if(reason!=null){value.put("reason",reason);value.put("message",safeMessage(reason));}notifyListeners("state",value);
    }
    @PluginMethod public void mute(PluginCall call){main.post(()->{Session session=commandSession(call);if(session!=null){if(session.engine==null){reject(call,"LIVE_SESSION");return;}session.engine.mute(Boolean.TRUE.equals(call.getBoolean("muted")));call.resolve();}});}
    @PluginMethod public void interrupt(PluginCall call){main.post(()->{Session session=commandSession(call);if(session!=null){if(session.engine==null){reject(call,"LIVE_SESSION");return;}session.engine.interrupt();call.resolve();}});}
    private Session commandSession(PluginCall call){Session session=active;if(session==null||!session.id.equals(call.getString("sessionId"))){reject(call,"LIVE_SESSION");return null;}return session;}
    @PluginMethod public void end(PluginCall call){main.post(()->{
        String id=call.getString("sessionId");if(!GleamSpeechTransport.validSessionId(id)){reject(call,"LIVE_SESSION");return;}
        Session session=active;if(session!=null&&session.id.equals(id))end(session,"ended");else identity.end(id);call.resolve();
    });}
    private void closeSocket(Session session){synchronized(GleamCredentialLock.LOCK){WebSocket socket=session.socket;session.socket=null;if(socket!=null)socket.cancel();}}
    private void end(Session session,String reason){if(active!=session)return;if(session.engine!=null)session.engine.end(reason);else finish(session,reason);}
    private void finish(Session session,String reason){
        if(active!=session)return;publish(session,true);if(session.publish!=null)main.removeCallbacks(session.publish);closeSocket(session);active=null;identity.end(session.id);GleamMicrophoneLease.release(session);
        if(permissionRequest==session)permissionRequest=null;if(session.permissionTimeout!=null)main.removeCallbacks(session.permissionTimeout);
        if(!session.ready)reject(session.call,reason);event(session,"ended",null,reason);
    }
    @Override protected void handleOnResume(){synchronized(GleamCredentialLock.LOCK){foreground=true;}}
    @Override protected void handleOnPause(){Session session;synchronized(GleamCredentialLock.LOCK){foreground=false;session=active;if(session!=null&&session.engine!=null)closeSocket(session);}if(session!=null&&session.engine!=null)end(session,"background");}
    @Override protected void handleOnStop(){Session session;synchronized(GleamCredentialLock.LOCK){foreground=false;session=active;if(session!=null)closeSocket(session);}if(session!=null)end(session,"background");}
    @Override protected void handleOnDestroy(){Session session;synchronized(GleamCredentialLock.LOCK){destroyed=true;foreground=false;GleamCredentialLock.remove(credentialsChanged);session=active;if(session!=null)closeSocket(session);}if(session!=null)end(session,"background");client.dispatcher().executorService().shutdown();client.connectionPool().evictAll();}
    private static void reject(PluginCall call,String code){call.reject(safeMessage(code),code);}
    private static String safeMessage(String code){
        switch(code){
            case "ended":case "background":return "语音已结束";
            case "LIVE_CONFIG":case "LIVE_AUTH":return "请到 AI 设置检查已验证的语音配置";
            case "LIVE_KEY_CHANGED":return "语音配置已改变，请重新开始";
            case "LIVE_PERMISSION_DENIED":return "请允许使用麦克风后重试";
            case "LIVE_BUSY":return "麦克风正在使用，请先结束上一段语音";
            case "LIVE_SESSION_LIMIT":return "本次通话已达 120 分钟，可重新开始";
            case "LIVE_LIMIT":return "本次语音已结束，可重新开始";
            case "LIVE_TIMEOUT":return "连接超时，请检查网络后重试";
            case "LIVE_AUDIO":return "声音暂不可用，请关闭占用麦克风的应用后重试";
            case "LIVE_AUDIO_BUFFER":return "回复音频缓存不可用，语音已停止，请重新开始";
            case "LIVE_AUDIO_ROUTE":return "耳机音频未就绪或连接已变化，语音已停止，请确认连接后重新开始";
            case "LIVE_INTERRUPTED":return "语音已中断，麦克风已关闭";
            default:return "语音未连接，请检查网络后重试";
        }
    }
}

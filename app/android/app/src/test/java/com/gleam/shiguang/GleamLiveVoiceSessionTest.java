package com.gleam.shiguang;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;

public class GleamLiveVoiceSessionTest {
    @Test public void layoutRequiresSuccessfulResponseAndDrainedAudioNotJustTranscriptDone() {
        Fixture f=new Fixture();f.connected();f.response();f.audio("reply-1");
        f.engine.receive("{\"type\":\"response.audio_transcript.done\",\"response_id\":\"reply-1\",\"item_id\":\"bot\",\"transcript\":\"完整回复\"}");
        assertFalse(f.turns.get(0).complete);assertEquals("bot",f.turns.get(0).id);
        f.engine.receive("{\"type\":\"response.done\",\"response\":{\"id\":\"reply-1\",\"status\":\"completed\"}}");
        assertFalse(f.turns.get(0).complete);f.playing=false;f.engine.drained();assertTrue(f.turns.get(0).complete);
        f=new Fixture();f.connected();f.response();
        f.engine.receive("{\"type\":\"response.audio_transcript.done\",\"response_id\":\"reply-1\",\"item_id\":\"cut\",\"transcript\":\"中断原话\"}");
        f.engine.interrupt();f.engine.receive("{\"type\":\"response.done\",\"response\":{\"id\":\"reply-1\",\"status\":\"completed\"}}");
        f.engine.drained();assertFalse(f.turns.get(0).complete);
    }
    @Test public void longSessionUsesTwoHourDeadlineAndDoesNotStopForHistoricalText() {
        Fixture f=new Fixture();f.connected();
        assertEquals(Long.valueOf(7200000),f.delays.get(f.delays.size()-1));
        for(int i=0;i<140;i++) {
            f.engine.receive("{\"type\":\"conversation.item.input_audio_transcription.completed\",\"item_id\":\"u"+i+"\",\"transcript\":\""+new String(new char[200]).replace('\0','文')+"\"}");
        }
        assertFalse(f.engine.closed());
        f.timers.get(f.timers.size()-1).run();assertEquals("LIVE_SESSION_LIMIT",f.ended);
    }
    @Test public void historicalTurnCountDoesNotCloseTheCallAndNativeBodiesStayBounded() throws Exception {
        Fixture f=new Fixture();f.connected();
        for(int i=0;i<140;i++)f.engine.receive("{\"type\":\"conversation.item.input_audio_transcription.completed\",\"item_id\":\"count"+i+"\",\"transcript\":\"字\"}");
        assertFalse(f.engine.closed());assertEquals(140,f.turns.size());
        java.lang.reflect.Field field=f.engine.getClass().getDeclaredField("turns");field.setAccessible(true);
        assertTrue(((java.util.Map<?,?>)field.get(f.engine)).size()<=32);
    }
    @Test public void historicalTextOver24kDoesNotCloseTheCall() {
        Fixture f=new Fixture();f.connected();
        for(int i=0;i<3;i++)f.engine.receive("{\"type\":\"conversation.item.input_audio_transcription.completed\",\"item_id\":\"text"+i+"\",\"transcript\":\""+new String(new char[9000]).replace('\0','字')+"\"}");
        assertFalse(f.engine.closed());assertEquals(3,f.turns.size());assertEquals(9000,f.turns.get(0).text.length());
    }
    @Test public void longSingleTranscriptAndReservedOrderRemainAvailableInUpdates() {
        Fixture f=new Fixture();f.connected();
        f.engine.receive("{\"type\":\"input_audio_buffer.speech_started\",\"item_id\":\"user\"}");
        f.response();
        f.engine.receive("{\"type\":\"response.audio_transcript.done\",\"response_id\":\"reply-1\",\"item_id\":\"bot\",\"transcript\":\""+new String(new char[13000]).replace('\0','长')+"\"}");
        assertFalse(f.engine.closed());assertEquals(13000,f.turns.get(f.turns.size()-1).text.length());
    }
    @Test public void blockedPlaybackAppendDoesNotHoldSessionLockForPcmInterruptOrEnd() throws Exception {
        CountDownLatch writing=new CountDownLatch(1),release=new CountDownLatch(1),controls=new CountDownLatch(1);
        Fixture f=new Fixture(){
            public Runnable preparePlay(byte[] bytes) {
                assertTrue(Thread.holdsLock(engine));
                return ()->{assertFalse(Thread.holdsLock(engine));writing.countDown();try{release.await(5,TimeUnit.SECONDS);}catch(InterruptedException error){Thread.currentThread().interrupt();}};
            }
        };
        f.connected();f.response();
        Thread receiver=new Thread(()->f.audio("reply-1"));receiver.start();assertTrue(writing.await(2,TimeUnit.SECONDS));
        Thread controller=new Thread(()->{f.engine.pcm(new byte[320],320);f.engine.interrupt();f.engine.end("ended");controls.countDown();});
        controller.start();
        try{assertTrue("append must not block microphone/cancel/end",controls.await(1,TimeUnit.SECONDS));}
        finally{release.countDown();receiver.join(2000);controller.join(2000);}
        assertTrue(f.engine.closed());
    }
    @Test public void finishKeepsCompletionPendingUntilResamplerTailIsDrained() {
        Fixture f=new Fixture(){public void finish(){playing=true;}};f.connected();f.response();
        f.engine.receive("{\"type\":\"response.audio_transcript.done\",\"response_id\":\"reply-1\",\"item_id\":\"tail\",\"transcript\":\"完整尾音\"}");
        f.engine.receive("{\"type\":\"response.done\",\"response\":{\"id\":\"reply-1\",\"status\":\"completed\"}}");
        assertFalse(f.turns.get(0).complete);f.engine.drained();assertFalse(f.turns.get(0).complete);
        f.playing=false;f.engine.drained();assertTrue(f.turns.get(0).complete);
    }
    static final String ACK = "{\"type\":\"session.updated\",\"session\":{\"id\":\"server-1\",\"model\":\"qwen3.8-omni-flash-realtime\",\"modalities\":[\"text\",\"audio\"],\"turn_detection\":{\"type\":\"server_vad\"},\"enable_search\":true,\"tools\":[],\"audio\":{\"input\":{\"format\":{\"type\":\"pcm\",\"sample_rate\":16000,\"channels\":1}},\"output\":{\"format\":{\"type\":\"pcm\",\"sample_rate\":24000}}}}}";
    static class Fixture implements GleamSpeechSession.Transport, GleamLiveVoiceSession.Audio, GleamLiveVoiceSession.Listener, GleamSpeechSession.Clock {
        int starts, stops, clears, plays, ready, closes; boolean muted, playing, failStart, failStop, denyStart, deferAudio;
        Runnable audioReady;
        String ended; List<GleamLiveVoiceSession.Turn> turns = new ArrayList<>();
        final List<String> sent = new ArrayList<>(), states = new ArrayList<>();
        final List<Runnable> timers = new ArrayList<>();
        final List<Long> delays = new ArrayList<>();
        final GleamLiveVoiceSession engine = new GleamLiveVoiceSession(this,this,this,this,"自然中文，不携带历史");
        public boolean send(String text) { sent.add(text); return true; }
        public void close() { closes++; }
        public void start() { starts++;if(denyStart)throw new SecurityException("permission revoked");if(failStart)throw new IllegalStateException("audio unavailable"); }
        public void start(Runnable callback) { start();if(deferAudio)audioReady=callback;else callback.run(); }
        public void stop() { stops++;if(failStop)throw new IllegalStateException("release failed"); }
        public void play(byte[] bytes) { plays++; playing=true; }
        public void clear() { clears++; playing=false; }
        public void mute(boolean value) { muted=value; }
        public void finish() { }
        public boolean playing() { return playing; }
        public void state(String value) { states.add(value); }
        public void ready() { ready++; }
        public void transcript(List<GleamLiveVoiceSession.Turn> value) {
            LinkedHashMap<String,GleamLiveVoiceSession.Turn> all=new LinkedHashMap<>();
            for(GleamLiveVoiceSession.Turn turn:turns)all.put(turn.id,turn);
            for(GleamLiveVoiceSession.Turn turn:value)all.put(turn.id,turn);
            turns=new ArrayList<>(all.values());turns.removeIf(turn->turn.text.trim().isEmpty());turns.sort((a,b)->Long.compare(order(a),order(b)));
        }
        private long order(GleamLiveVoiceSession.Turn turn) {
            try{return turn.getClass().getDeclaredField("order").getLong(turn);}catch(Exception ignored){return 0;}
        }
        public void ended(String reason) { ended=reason; }
        public GleamSpeechSession.Timer after(long ms,Runnable task) { timers.add(task);delays.add(ms);return ()->{}; }
        void connected() {
            engine.begin();engine.receive("{\"type\":\"session.created\",\"session\":{\"id\":\"server-1\",\"model\":\"qwen3.8-omni-flash-realtime\"}}");engine.receive(ACK);
        }
        void response() { engine.receive("{\"type\":\"response.created\",\"response\":{\"id\":\"reply-1\"}}"); }
        void audio(String id) { engine.receive("{\"type\":\"response.audio.delta\",\"response_id\":\""+id+"\",\"delta\":\"AQIDBA==\"}"); }
    }
    @Test public void listeningWaitsForAudioRouteAndLateRouteCannotRestartCancelledCall() {
        Fixture f=new Fixture();f.deferAudio=true;f.connected();
        assertEquals(0,f.ready);assertFalse(f.states.contains("listening"));
        int sent=f.sent.size();f.engine.pcm(new byte[320],320);assertEquals(sent,f.sent.size());
        f.audioReady.run();assertEquals(1,f.ready);assertTrue(f.states.contains("listening"));
        f.audioReady.run();assertEquals(1,f.ready);
        Fixture cancelled=new Fixture();cancelled.deferAudio=true;cancelled.connected();cancelled.engine.end("ended");
        cancelled.audioReady.run();assertEquals(0,cancelled.ready);assertFalse(cancelled.states.contains("listening"));
    }
    @Test public void routeDeadlineClosesCaptureAndRejectsLateReady() {
        Fixture f=new Fixture();f.deferAudio=true;f.connected();
        f.timers.get(1).run();assertEquals("LIVE_AUDIO_ROUTE",f.ended);assertTrue(f.stops>0);
        f.audioReady.run();assertEquals(0,f.ready);assertFalse(f.states.contains("listening"));
        int sent=f.sent.size();f.engine.pcm(new byte[320],320);assertEquals(sent,f.sent.size());
    }
    @Test public void microphoneWaitsForMatchingAudioAcknowledgement() throws Exception {
        Fixture f=new Fixture();f.engine.begin();assertEquals(0,f.starts);
        f.engine.receive("{\"type\":\"session.created\",\"session\":{\"id\":\"server-1\"}}");assertEquals(0,f.starts);
        JSONObject update=new JSONObject(f.sent.get(0)).getJSONObject("session");
        assertEquals("server_vad",update.getJSONObject("turn_detection").getString("type"));
        assertEquals(24000,update.getJSONObject("audio").getJSONObject("output").getJSONObject("format").getInt("sample_rate"));
        assertTrue(update.getBoolean("enable_search"));assertTrue(update.getJSONObject("search_options").getBoolean("enable_source"));assertFalse(update.has("tools"));
        assertFalse(update.has("messages"));f.engine.receive(ACK);assertEquals(1,f.starts);assertEquals(1,f.ready);
        f.engine.receive(ACK);assertTrue(f.engine.closed());assertEquals(1,f.starts);
    }
    @Test public void unsafeAckCannotAcquireAudio() throws Exception {
        for(String wrong:new String[]{ACK.replace("24000","16000"),ACK.replace("server_vad","manual"),ACK.replace("\"channels\":1","\"channels\":2"),ACK.replace("server-1","other"),ACK.replace("\"enable_search\":true","\"enable_search\":false"),ACK.replace("\"tools\":[]","\"tools\":[{\"type\":\"function\"}]")}) {
            Fixture f=new Fixture();f.engine.begin();f.engine.receive("{\"type\":\"session.created\",\"session\":{\"id\":\"server-1\"}}");f.engine.receive(wrong);
            assertEquals(0,f.starts);assertTrue(f.engine.closed());
        }
    }
    @Test public void searchResultsStayOnTheirResponseAndSurviveAudioDrain() throws Exception {
        Fixture f=new Fixture();f.connected();f.response();f.audio("reply-1");
        f.engine.receive("{\"type\":\"response.audio_transcript.done\",\"response_id\":\"reply-1\",\"item_id\":\"a1\",\"transcript\":\"本轮天气\"}");
        f.engine.receive("{\"type\":\"response.done\",\"response\":{\"id\":\"reply-1\",\"status\":\"completed\",\"usage\":{\"plugins\":{\"search\":{\"count\":1}}},\"search_results\":[{\"title\":\"天气\",\"url\":\"https://weather.invalid/\"}]}}");
        assertEquals("searched",f.turns.get(0).search.getString("status"));assertFalse(f.turns.get(0).complete);
        f.playing=false;f.engine.drained();assertTrue(f.turns.get(0).complete);assertEquals(1,f.turns.get(0).search.getJSONArray("sources").length());
        f.engine.receive("{\"type\":\"response.created\",\"response\":{\"id\":\"reply-2\"}}");
        f.engine.receive("{\"type\":\"response.audio_transcript.done\",\"response_id\":\"reply-2\",\"item_id\":\"a2\",\"transcript\":\"被打断\"}");f.engine.interrupt();
        f.engine.receive("{\"type\":\"response.done\",\"response\":{\"id\":\"reply-2\",\"status\":\"completed\",\"usage\":{\"plugins\":{\"search\":{\"count\":1}}}}}");
        assertEquals("enabled",f.turns.get(1).search.getString("status"));assertEquals("searched",f.turns.get(0).search.getString("status"));
    }
    @Test public void duplexPlaybackAndFinalTranscriptsRemainOrdered() {
        Fixture f=new Fixture();f.connected();
        f.engine.receive("{\"type\":\"input_audio_buffer.speech_started\",\"item_id\":\"user-1\"}");f.response();
        f.engine.receive("{\"type\":\"response.output_item.added\",\"item\":{\"id\":\"assistant-1\",\"role\":\"assistant\"}}");
        f.audio("reply-1");assertEquals(1,f.plays);
        f.engine.receive("{\"type\":\"response.audio_transcript.done\",\"response_id\":\"reply-1\",\"item_id\":\"assistant-1\",\"transcript\":\"你好\"}");
        f.engine.receive("{\"type\":\"conversation.item.input_audio_transcription.completed\",\"item_id\":\"user-1\",\"transcript\":\"早上好\"}");
        assertEquals("user",f.turns.get(0).role);assertEquals("早上好",f.turns.get(0).text);assertEquals("assistant",f.turns.get(1).role);
        f.engine.receive("{\"type\":\"response.done\",\"response\":{\"id\":\"reply-1\",\"status\":\"completed\"}}");
        assertEquals("speaking",f.states.get(f.states.size()-1));f.playing=false;f.engine.drained();assertEquals("listening",f.states.get(f.states.size()-1));
    }
    @Test public void interruptFlushesQueuedAudioAndRejectsLateResponseData() {
        Fixture f=new Fixture();f.connected();f.response();f.audio("reply-1");f.engine.interrupt();int played=f.plays;
        f.audio("reply-1");assertEquals(played,f.plays);assertTrue(f.clears>0);assertTrue(f.sent.stream().anyMatch(s->s.contains("response.cancel")));
        f.engine.receive("{\"type\":\"response.audio_transcript.done\",\"response_id\":\"reply-1\",\"item_id\":\"old\",\"transcript\":\"迟到\"}");assertTrue(f.turns.isEmpty());
    }
    @Test public void muteAndEndNeverSendMorePcmOrRestart() {
        Fixture f=new Fixture();f.connected();f.engine.mute(true);int n=f.sent.size();f.engine.pcm(new byte[3200],3200);assertEquals(n,f.sent.size());
        f.engine.mute(false);f.engine.pcm(new byte[3200],3200);assertTrue(f.sent.size()>n);
        f.engine.end("background");n=f.sent.size();f.engine.pcm(new byte[3200],3200);f.engine.receive(ACK);assertEquals(n,f.sent.size());assertEquals(1,f.starts);assertTrue(f.stops>0);assertEquals("background",f.ended);
    }
    @Test public void timeoutAndProtocolFailureCloseBothDirections() {
        Fixture f=new Fixture();f.engine.begin();f.timers.get(0).run();assertTrue(f.engine.closed());assertTrue(f.closes>0);
        f=new Fixture();f.connected();f.engine.receive("{\"type\":\"error\",\"error\":{\"message\":\"private-provider-marker\"}}");assertTrue(f.engine.closed());assertFalse(f.ended.contains("private-provider-marker"));
    }
    @Test public void audioFailureAndReleaseFailureStillCloseTransportAndReportEnd() {
        Fixture f=new Fixture();f.failStart=true;f.connected();assertEquals(0,f.ready);assertEquals("LIVE_AUDIO",f.ended);assertEquals(1,f.closes);
        f=new Fixture();f.denyStart=true;f.connected();assertEquals("LIVE_PERMISSION_DENIED",f.ended);assertEquals(1,f.closes);
        f=new Fixture();f.connected();f.failStop=true;f.engine.end("background");assertEquals("background",f.ended);assertEquals(1,f.closes);
    }
    @Test public void lateBenignCancelErrorCannotEndTheNextResponse() {
        Fixture f=new Fixture();f.connected();f.response();f.engine.interrupt();
        f.engine.receive("{\"type\":\"response.created\",\"response\":{\"id\":\"reply-2\"}}");
        f.engine.receive("{\"type\":\"error\",\"error\":{\"code\":\"response_cancel_not_active\"}}");
        assertFalse(f.engine.closed());f.audio("reply-2");assertEquals(1,f.plays);
    }
    @Test public void liveTranscriptionReplacesUserPreviewAndAppendsAssistantDeltasOnlyOnce() {
        Fixture f=new Fixture();f.connected();
        f.engine.receive("{\"type\":\"input_audio_buffer.speech_started\",\"item_id\":\"user-1\"}");
        f.engine.receive("{\"type\":\"conversation.item.input_audio_transcription.delta\",\"item_id\":\"user-1\",\"content_index\":0,\"text\":\"\",\"stash\":\"周六\"}");
        assertEquals("周六",f.turns.get(0).text);
        f.engine.receive("{\"type\":\"conversation.item.input_audio_transcription.delta\",\"item_id\":\"user-1\",\"content_index\":0,\"text\":\"周六\",\"stash\":\"去散步\"}");
        assertEquals("周六去散步",f.turns.get(0).text);assertEquals(1,f.turns.size());
        f.engine.receive("{\"type\":\"conversation.item.input_audio_transcription.completed\",\"item_id\":\"user-1\",\"transcript\":\"周六去爬山\"}");
        f.engine.receive("{\"type\":\"conversation.item.input_audio_transcription.delta\",\"item_id\":\"user-1\",\"text\":\"迟到\",\"stash\":\"\"}");
        assertEquals("周六去爬山",f.turns.get(0).text);f.response();
        String delta="{\"type\":\"response.audio_transcript.delta\",\"event_id\":\"delta-1\",\"response_id\":\"reply-1\",\"item_id\":\"assistant-1\",\"delta\":\"Hello \"}";
        f.engine.receive(delta);f.engine.receive(delta);
        f.engine.receive("{\"type\":\"response.output_audio_transcript.delta\",\"response_id\":\"reply-1\",\"item_id\":\"assistant-1\",\"delta\":\"world\"}");
        assertEquals("Hello world",f.turns.get(1).text);assertEquals(2,f.turns.size());
        f.engine.receive("{\"type\":\"response.audio_transcript.done\",\"response_id\":\"reply-1\",\"item_id\":\"assistant-1\",\"transcript\":\"Hello, world!\"}");
        f.engine.receive("{\"type\":\"response.audio_transcript.delta\",\"response_id\":\"reply-1\",\"item_id\":\"assistant-1\",\"delta\":\"迟到\"}");
        assertEquals("Hello, world!",f.turns.get(1).text);
    }
}

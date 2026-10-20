package com.gleam.shiguang;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
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
    static final String ACK = "{\"type\":\"session.updated\",\"session\":{\"id\":\"server-1\",\"model\":\"qwen3.8-omni-flash-realtime\",\"modalities\":[\"text\",\"audio\"],\"turn_detection\":{\"type\":\"server_vad\"},\"enable_search\":false,\"tools\":[],\"audio\":{\"input\":{\"format\":{\"type\":\"pcm\",\"sample_rate\":16000,\"channels\":1}},\"output\":{\"format\":{\"type\":\"pcm\",\"sample_rate\":24000}}}}}";
    static class Fixture implements GleamSpeechSession.Transport, GleamLiveVoiceSession.Audio, GleamLiveVoiceSession.Listener, GleamSpeechSession.Clock {
        int starts, stops, clears, plays, ready, closes; boolean muted, playing, failStart, failStop, denyStart;
        String ended; List<GleamLiveVoiceSession.Turn> turns = new ArrayList<>();
        final List<String> sent = new ArrayList<>(), states = new ArrayList<>();
        final List<Runnable> timers = new ArrayList<>();
        final GleamLiveVoiceSession engine = new GleamLiveVoiceSession(this,this,this,this,"自然中文，不携带历史");
        public boolean send(String text) { sent.add(text); return true; }
        public void close() { closes++; }
        public void start() { starts++;if(denyStart)throw new SecurityException("permission revoked");if(failStart)throw new IllegalStateException("audio unavailable"); }
        public void stop() { stops++;if(failStop)throw new IllegalStateException("release failed"); }
        public void play(byte[] bytes) { plays++; playing=true; }
        public void clear() { clears++; playing=false; }
        public void mute(boolean value) { muted=value; }
        public void finish() { }
        public boolean playing() { return playing; }
        public void state(String value) { states.add(value); }
        public void ready() { ready++; }
        public void transcript(List<GleamLiveVoiceSession.Turn> value) { turns=value; }
        public void ended(String reason) { ended=reason; }
        public GleamSpeechSession.Timer after(long ms,Runnable task) { timers.add(task);return ()->{}; }
        void connected() {
            engine.begin();engine.receive("{\"type\":\"session.created\",\"session\":{\"id\":\"server-1\",\"model\":\"qwen3.8-omni-flash-realtime\"}}");engine.receive(ACK);
        }
        void response() { engine.receive("{\"type\":\"response.created\",\"response\":{\"id\":\"reply-1\"}}"); }
        void audio(String id) { engine.receive("{\"type\":\"response.audio.delta\",\"response_id\":\""+id+"\",\"delta\":\"AQIDBA==\"}"); }
    }
    @Test public void microphoneWaitsForMatchingAudioAcknowledgement() throws Exception {
        Fixture f=new Fixture();f.engine.begin();assertEquals(0,f.starts);
        f.engine.receive("{\"type\":\"session.created\",\"session\":{\"id\":\"server-1\"}}");assertEquals(0,f.starts);
        JSONObject update=new JSONObject(f.sent.get(0)).getJSONObject("session");
        assertEquals("server_vad",update.getJSONObject("turn_detection").getString("type"));
        assertEquals(24000,update.getJSONObject("audio").getJSONObject("output").getJSONObject("format").getInt("sample_rate"));
        assertFalse(update.has("messages"));f.engine.receive(ACK);assertEquals(1,f.starts);assertEquals(1,f.ready);
        f.engine.receive(ACK);assertTrue(f.engine.closed());assertEquals(1,f.starts);
    }
    @Test public void unsafeAckCannotAcquireAudio() throws Exception {
        for(String wrong:new String[]{ACK.replace("24000","16000"),ACK.replace("server_vad","manual"),ACK.replace("\"channels\":1","\"channels\":2"),ACK.replace("server-1","other"),ACK.replace("\"enable_search\":false","\"enable_search\":true")}) {
            Fixture f=new Fixture();f.engine.begin();f.engine.receive("{\"type\":\"session.created\",\"session\":{\"id\":\"server-1\"}}");f.engine.receive(wrong);
            assertEquals(0,f.starts);assertTrue(f.engine.closed());
        }
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

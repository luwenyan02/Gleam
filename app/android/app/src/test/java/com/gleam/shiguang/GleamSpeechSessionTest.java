package com.gleam.shiguang;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class GleamSpeechSessionTest {
    static class Fixture implements GleamSpeechSession.Transport, GleamSpeechSession.Audio, GleamSpeechSession.Listener, GleamSpeechSession.Clock {
        final List<String> sent = new ArrayList<>();
        final List<Runnable> scheduled = new ArrayList<>();
        final List<String> states = new ArrayList<>();
        int starts, stops, closes, results, errors, connections;
        String text, code;
        boolean sendOk = true;
        GleamSpeechSession session = new GleamSpeechSession(this, this, this, this);
        public boolean send(String message) { sent.add(message); return sendOk; }
        public void close() { closes++; }
        public void start() { starts++; }
        public void stop() { stops++; }
        public void state(String value) { states.add(value); }
        public void complete(String value) { results++; text = value; }
        public void connected() { connections++; }
        public void fail(String value) { errors++; code = value; }
        public GleamSpeechSession.Timer after(long ms, Runnable work) { scheduled.add(work); return () -> {}; }
        void ready() { session.begin(); session.event("session.created", null, null, -1, true); session.event("session.updated", null, null, -1, true); }
        void pcm() { session.audio(new byte[3200], 3200); }
        void committed() { session.event("input_audio_buffer.committed", "item-fictional", null, -1, true); }
        void finalText(String value) { session.event("conversation.item.input_audio_transcription.completed", "item-fictional", value, 0, true); }
    }
    @Test public void manualStopCommitsExactlyOneUtteranceWithoutAssistantGeneration() {
        Fixture f = new Fixture(); f.ready(); f.pcm(); f.session.stop(); f.session.stop(); f.committed(); f.finalText("午饭二十八元"); f.finalText("重复");
        assertEquals(1, f.starts); assertEquals(1, f.results); assertEquals("午饭二十八元", f.text);
        assertEquals(1, f.sent.stream().filter(v -> v.contains("input_audio_buffer.commit")).count());
        assertFalse(f.sent.stream().anyMatch(v -> v.contains("response.create")));
        assertTrue(f.sent.get(0).contains("\"turn_detection\":null"));
        assertTrue(f.sent.get(0).contains("\"modalities\":[\"text\"]"));
    }
    @Test public void earlyStopAndLateAckNeverStartMicrophone() {
        Fixture f = new Fixture(); f.session.begin(); f.session.stop(); f.session.event("session.updated", null, null, -1, true);
        assertEquals(0, f.starts); assertEquals("SPEECH_CANCELLED", f.code); assertEquals(0, f.results);
    }
    @Test public void cancelRejectsLateFinalAndAudio() {
        Fixture f = new Fixture(); f.ready(); f.pcm(); f.session.stop(); f.committed(); f.session.cancel("SPEECH_CANCELLED"); int count = f.sent.size(); f.finalText("晚到的结果"); f.pcm();
        assertEquals(0, f.results); assertEquals(1, f.errors); assertEquals(count, f.sent.size());
    }
    @Test public void onlyCommittedInputTranscriptionBecomesResult() {
        Fixture f = new Fixture(); f.ready(); f.pcm(); f.session.event("response.text.done", "assistant-item", "伪助手答复", 0, true); f.finalText("早到结果");
        assertEquals(0, f.results); f.session.stop(); f.committed(); f.session.event("conversation.item.input_audio_transcription.completed", "wrong-item", "错误轮次", 0, true); assertEquals(0, f.results); f.finalText("正确短句"); assertEquals("正确短句", f.text);
    }
    @Test public void reorderedPostStopTranscriptionWaitsForMatchingCommitAck() {
        Fixture f = new Fixture(); f.ready(); f.pcm(); f.session.stop(); f.finalText("确认过的短句"); assertEquals(0, f.results); f.committed(); assertEquals(1, f.results); assertEquals("确认过的短句", f.text);
    }
    @Test public void cancelDiscardsBufferedPostStopTranscription() {
        Fixture f = new Fixture(); f.ready(); f.pcm(); f.session.stop(); f.finalText("不应返回"); f.session.cancel("SPEECH_CANCELLED"); f.committed(); assertEquals(0, f.results); assertEquals(1, f.errors);
    }
    @Test public void unsafeSessionAckFailsBeforeCapture() {
        Fixture f = new Fixture(); f.session.begin(); f.session.event("session.created", null, null, -1, true); f.session.event("session.updated", null, null, -1, false);
        assertEquals(0, f.starts); assertEquals("SPEECH_PROTOCOL", f.code);
    }
    @Test public void noAudioAndOversizedTranscriptFailWithoutTruncation() {
        Fixture empty = new Fixture(); empty.ready(); empty.session.stop(); assertEquals("SPEECH_AUDIO_EMPTY", empty.code);
        Fixture longText = new Fixture(); longText.ready(); longText.pcm(); longText.session.stop(); longText.committed(); longText.finalText(new String(new char[501]).replace('\0', '中'));
        assertEquals(0, longText.results); assertEquals("SPEECH_TRANSCRIPT_LIMIT", longText.code);
    }
    @Test public void payloadCapDoesNotAutoCommit() {
        Fixture f = new Fixture(); f.ready(); byte[] pcm = new byte[3200]; for (int i = 0; i <= 300; i++) f.session.audio(pcm, pcm.length);
        assertEquals("SPEECH_LIMIT", f.code); assertFalse(f.sent.stream().anyMatch(v -> v.contains("input_audio_buffer.commit"))); assertEquals(0, f.results);
    }
    @Test public void timeoutInterruptAndDisconnectReleaseCaptureExactlyOnce() {
        for (String code : new String[]{"SPEECH_TIMEOUT", "SPEECH_INTERRUPTED", "SPEECH_NETWORK", "SPEECH_KEY_CHANGED"}) {
            Fixture f = new Fixture(); f.ready(); f.session.cancel(code); f.session.cancel(code); f.finalText("已取消");
            assertEquals(1, f.stops); assertEquals(1, f.closes); assertEquals(1, f.errors); assertEquals(0, f.results);
        }
    }
    @Test public void thirtySecondDeadlineCancelsWithoutCommitOrFutureRestart() {
        Fixture f = new Fixture(); f.ready(); f.pcm(); f.scheduled.get(1).run(); f.session.event("session.updated", null, null, -1, true);
        assertEquals("SPEECH_LIMIT", f.code); assertEquals(1, f.starts); assertFalse(f.sent.stream().anyMatch(v -> v.contains("input_audio_buffer.commit")));
    }
    @Test public void transportFailureAndInvalidPcmFailSafely() {
        Fixture network = new Fixture(); network.session.begin(); network.sendOk = false; network.session.event("session.created", null, null, -1, true); assertEquals("SPEECH_NETWORK", network.code);
        Fixture pcm = new Fixture(); pcm.ready(); pcm.session.audio(new byte[3], 3); assertEquals("SPEECH_AUDIO_UNAVAILABLE", pcm.code);
    }
    private Fixture diagnostic() {
        Fixture f = new Fixture();
        f.session = GleamSpeechSession.connectionTest(f, f, f);
        return f;
    }
    @Test public void connectionTestUsesOnlyExactSessionUpdateAndNeverTouchesAudio() {
        Fixture f = diagnostic(); f.ready();
        assertEquals(1, f.connections); assertEquals(0, f.results); assertEquals(0, f.errors);
        assertEquals(0, f.starts); assertEquals(0, f.stops); assertEquals(1, f.closes);
        assertEquals(1, f.sent.size()); assertEquals(GleamSpeechSession.SESSION_UPDATE, f.sent.get(0));
        assertTrue(f.session.isClosed()); assertEquals("configuring", f.session.phase().value);
        f.pcm(); f.session.stop(); f.finalText("不能成为结果"); f.session.cancel("SPEECH_CANCELLED");
        assertEquals(1, f.sent.size()); assertEquals(1, f.connections); assertEquals(0, f.errors);
    }
    @Test public void connectionTestRequiresCreatedThenFullSafeAcknowledgement() {
        Fixture f = diagnostic(); f.session.begin();
        f.session.event("session.updated", null, null, -1, true);
        assertEquals(0, f.connections); assertTrue(f.sent.isEmpty());
        f.session.event("session.created", null, null, -1, true);
        f.session.event("session.updated", null, null, -1, false);
        assertEquals("SPEECH_PROTOCOL", f.code); assertEquals("configuring", f.session.phase().value);
        assertEquals(0, f.connections); assertEquals(0, f.starts);
    }
    @Test public void diagnosticFailuresCancelCloseAndRejectLateEventsInBothNetworkPhases() {
        for (boolean configured : new boolean[]{false, true}) {
            for (String code : new String[]{"SPEECH_CANCELLED", "SPEECH_INTERRUPTED", "SPEECH_KEY_CHANGED", "SPEECH_NETWORK", "SPEECH_TLS", "SPEECH_AUTH", "SPEECH_PROVIDER", "SPEECH_PROTOCOL"}) {
                Fixture f = diagnostic(); f.session.begin();
                if (configured) f.session.event("session.created", null, null, -1, true);
                f.session.cancel(code); f.session.cancel(code);
                f.session.event("session.created", null, null, -1, true);
                f.session.event("session.updated", null, null, -1, true); f.pcm(); f.session.stop();
                assertEquals(code, f.code); assertEquals(1, f.errors); assertEquals(1, f.closes);
                assertEquals(configured ? "configuring" : "connecting", f.session.phase().value);
                assertEquals(0, f.connections); assertEquals(0, f.results); assertEquals(0, f.starts);
                assertEquals(configured ? 1 : 0, f.sent.size());
            }
        }
    }
    @Test public void diagnosticTimeoutAndRejectedUpdateNeverStartOrCommitAudio() {
        for (boolean configuring : new boolean[]{false, true}) {
            Fixture f = diagnostic(); f.session.begin();
            if (configuring) f.session.event("session.created", null, null, -1, true);
            f.scheduled.get(0).run();
            f.session.event("session.updated", null, null, -1, true);
            assertEquals("SPEECH_TIMEOUT", f.code); assertEquals(0, f.connections); assertEquals(0, f.starts);
        }
        Fixture rejected = diagnostic(); rejected.session.begin(); rejected.sendOk = false;
        rejected.session.event("session.created", null, null, -1, true);
        assertEquals("SPEECH_NETWORK", rejected.code); assertEquals("configuring", rejected.session.phase().value);
        assertEquals(0, rejected.starts);
    }
    @Test public void staleConnectionTimerCannotCancelRecordingOrSuccessfulTest() {
        Fixture recording = new Fixture(); recording.ready(); recording.scheduled.get(0).run();
        assertEquals(0, recording.errors); assertFalse(recording.session.isClosed());
        Fixture diagnostic = diagnostic(); diagnostic.ready(); diagnostic.scheduled.get(0).run();
        assertEquals(0, diagnostic.errors); assertEquals(1, diagnostic.connections);
    }
    @Test public void recordingFailurePhasesRemainAvailableAfterTeardown() {
        Fixture f = new Fixture(); assertEquals("validation", f.session.phase().value);
        f.session.begin(); assertEquals("connecting", f.session.phase().value);
        f.session.event("session.created", null, null, -1, true); assertEquals("configuring", f.session.phase().value);
        f.session.event("session.updated", null, null, -1, true); assertEquals("microphone", f.session.phase().value);
        f.pcm(); f.session.stop(); assertEquals("transcribing", f.session.phase().value);
        f.session.cancel("SPEECH_NETWORK"); assertEquals("transcribing", f.session.phase().value);
    }

    @Test public void stoppingDiagnosticHandshakeOnlyCancelsAndNeverCommits() {
        for (boolean configuring : new boolean[]{false, true}) {
            Fixture f = diagnostic(); f.session.begin();
            if (configuring) f.session.event("session.created", null, null, -1, true);
            f.pcm(); f.session.stop(); f.session.stop();
            f.session.event("session.updated", null, null, -1, true);
            assertEquals("SPEECH_CANCELLED", f.code); assertEquals(1, f.errors); assertEquals(0, f.starts); assertEquals(0, f.connections);
            assertFalse(f.sent.stream().anyMatch(value -> value.contains("input_audio_buffer") || value.contains("response.create")));
        }
    }

}

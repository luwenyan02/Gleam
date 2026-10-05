package com.gleam.shiguang;

import okio.ByteString;

/** Single Manual-mode utterance. No Android APIs, credentials, files, or assistant output. */
final class GleamSpeechSession {
    static final int SAMPLE_RATE = 16000;
    static final int FRAME_BYTES = 3200;
    static final int MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 30;
    static final int MAX_TRANSCRIPT_CHARS = 500;
    static final int MAX_EVENT_CHARS = 65536;
    static final String SESSION_UPDATE = "{\"type\":\"session.update\",\"session\":{\"modalities\":[\"text\"],\"turn_detection\":null,\"input_audio_transcription\":{\"model\":\"qwen3-asr-flash-realtime\"},\"enable_search\":false,\"tools\":[],\"audio\":{\"input\":{\"format\":{\"type\":\"pcm\",\"sample_rate\":16000,\"sample_format\":\"s16le\",\"channels\":1,\"packing\":\"interleaved\",\"channel_layout\":\"mono\"}}}}}";
    interface Transport { boolean send(String message); void close(); }
    interface Audio { void start() throws Exception; void stop(); }
    interface Listener { void state(String value); void complete(String text); void fail(String code); }
    interface Timer { void cancel(); }
    interface Clock { Timer after(long ms, Runnable work); }
    private enum State { NEW, CONNECTING, CONFIGURING, LISTENING, TRANSCRIBING, CLOSED }
    private final Transport transport;
    private final Audio audio;
    private final Listener listener;
    private final Clock clock;
    private State state = State.NEW;
    private Timer deadline;
    private int bytes;
    private String committedItem, pendingItem, pendingText;
    private boolean audioStarted;

    GleamSpeechSession(Transport transport, Audio audio, Listener listener, Clock clock) {
        this.transport = transport; this.audio = audio; this.listener = listener; this.clock = clock;
    }
    synchronized void begin() {
        if (state != State.NEW) return;
        state = State.CONNECTING;
        listener.state("connecting");
        deadline = clock.after(15000, () -> cancel("SPEECH_TIMEOUT"));
    }
    synchronized void event(String type, String itemId, String text, int contentIndex, boolean safeConfiguration) {
        if (state == State.CLOSED || state == State.NEW) return;
        if ("session.created".equals(type) && state == State.CONNECTING) {
            state = State.CONFIGURING;
            send(SESSION_UPDATE);
        } else if ("session.updated".equals(type) && state == State.CONFIGURING) {
            if (!safeConfiguration) { cancel("SPEECH_PROTOCOL"); return; }
            clearDeadline();
            state = State.LISTENING;
            try { audioStarted = true; audio.start(); }
            catch (Exception ignored) { cancel("SPEECH_AUDIO_UNAVAILABLE"); return; }
            if (state != State.LISTENING) return;
            listener.state("listening");
            deadline = clock.after(30000, () -> cancel("SPEECH_LIMIT"));
        } else if ("input_audio_buffer.committed".equals(type) && state == State.TRANSCRIBING) {
            if (!validItem(itemId) || (committedItem != null && !committedItem.equals(itemId))) { cancel("SPEECH_PROTOCOL"); return; }
            committedItem = itemId;
            if (pendingItem != null && pendingItem.equals(committedItem)) acceptTranscript(pendingText);
            pendingItem = null; pendingText = null;
        } else if ("conversation.item.input_audio_transcription.completed".equals(type) && state == State.TRANSCRIBING) {
            if (!validItem(itemId) || contentIndex != 0) return;
            if (text != null && text.length() > MAX_TRANSCRIPT_CHARS) { cancel("SPEECH_TRANSCRIPT_LIMIT"); return; }
            if (committedItem == null) {
                if (pendingItem != null && !pendingItem.equals(itemId)) { cancel("SPEECH_PROTOCOL"); return; }
                pendingItem = itemId; pendingText = text;
            } else if (committedItem.equals(itemId)) acceptTranscript(text);
        } else if ("conversation.item.input_audio_transcription.failed".equals(type)) {
            cancel("SPEECH_TRANSCRIPTION_FAILED");
        }
        // response.* and partial input transcription are deliberately ignored.
    }
    private void acceptTranscript(String text) {
        if (text == null || text.trim().isEmpty()) { cancel("SPEECH_AUDIO_EMPTY"); return; }
        finish(); listener.complete(text.trim());
    }
    private static boolean validItem(String value) { return value != null && !value.isEmpty() && value.length() <= 1024; }
    synchronized void audio(byte[] pcm, int length) {
        if (state != State.LISTENING) return;
        if (pcm == null || length <= 0 || length > FRAME_BYTES || length > pcm.length || length % 2 != 0) { cancel("SPEECH_AUDIO_UNAVAILABLE"); return; }
        if (bytes > MAX_AUDIO_BYTES - length) { cancel("SPEECH_LIMIT"); return; }
        bytes += length;
        send("{\"type\":\"input_audio_buffer.append\",\"audio\":\"" + ByteString.of(pcm, 0, length).base64() + "\"}");
    }
    synchronized void stop() {
        if (state == State.CLOSED || state == State.TRANSCRIBING) return;
        if (state != State.LISTENING) { cancel("SPEECH_CANCELLED"); return; }
        stopAudio(); clearDeadline();
        if (bytes == 0) { cancel("SPEECH_AUDIO_EMPTY"); return; }
        state = State.TRANSCRIBING;
        if (!send("{\"type\":\"input_audio_buffer.commit\"}")) return;
        listener.state("transcribing");
        deadline = clock.after(15000, () -> cancel("SPEECH_TIMEOUT"));
    }
    synchronized void cancel(String code) {
        if (state == State.CLOSED) return;
        finish(); listener.fail(code);
    }
    synchronized boolean isClosed() { return state == State.CLOSED; }
    private boolean send(String message) {
        boolean accepted;
        try { accepted = transport.send(message); }
        catch (RuntimeException ignored) { accepted = false; }
        if (!accepted) cancel("SPEECH_NETWORK");
        return accepted;
    }
    private void clearDeadline() { if (deadline != null) { deadline.cancel(); deadline = null; } }
    private void stopAudio() { if (audioStarted) { audioStarted = false; try { audio.stop(); } catch (RuntimeException ignored) {} } }
    private void finish() { state = State.CLOSED; clearDeadline(); stopAudio(); try { transport.close(); } catch (RuntimeException ignored) {} committedItem = null; pendingItem = null; pendingText = null; bytes = 0; }
}

package com.gleam.shiguang;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import static com.gleam.shiguang.GleamSpeechProtocolReason.*;
import org.json.JSONObject;
import java.util.List;
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
    interface Listener { void state(String value); void complete(String text); void fail(String code); default void connected() {} default void partial(String text) {} }
    interface Timer { void cancel(); }
    interface Clock { Timer after(long ms, Runnable work); }
    enum Phase {
        VALIDATION("validation"), PERMISSION("permission"), CONNECTING("connecting"), CONFIGURING("configuring"), MICROPHONE("microphone"), TRANSCRIBING("transcribing");
        final String value;
        Phase(String value) { this.value = value; }
    }
    private enum State { NEW, CONNECTING, CONFIGURING, LISTENING, TRANSCRIBING, CLOSED }
    private final Transport transport;
    private final Audio audio;
    private final boolean connectionOnly;
    private final Listener listener;
    private final Clock clock;
    private State state = State.NEW;
    private Phase phase = Phase.VALIDATION;
    private List<GleamSpeechProtocolReason> protocolReasons = Collections.emptyList();
    private long deadlineGeneration;
    private Timer deadline;
    private int bytes;
    private String committedItem, pendingItem, pendingText;
    private String previewItem;
    private boolean audioStarted;
    private boolean manualUpdatePending;
    private String serverSessionId;

    GleamSpeechSession(Transport transport, Audio audio, Listener listener, Clock clock) {
        this(transport, audio, listener, clock, false);
    }
    private GleamSpeechSession(Transport transport, Audio audio, Listener listener, Clock clock, boolean connectionOnly) {
        this.transport = transport; this.audio = audio; this.listener = listener; this.clock = clock; this.connectionOnly = connectionOnly;
    }
    /** A diagnostic cannot acquire an Audio dependency, even before the configuration is acknowledged. */
    static GleamSpeechSession connectionTest(Transport transport, Listener listener, Clock clock) {
        return new GleamSpeechSession(transport, null, listener, clock, true);
    }
    synchronized void begin() {
        if (state != State.NEW) return;
        state = State.CONNECTING; phase = Phase.CONNECTING;
        listener.state("connecting");
        armDeadline(15000, "SPEECH_TIMEOUT");
    }
    synchronized void sessionCreated(JSONObject event) {
        if (state == State.CLOSED || state == State.NEW) return;
        if (state != State.CONNECTING || manualUpdatePending) { protocolFailure(ACK_UNEXPECTED_SESSION_EVENT); return; }
        JSONObject session = event.optJSONObject("session");
        if (event.has("session") && session == null) { protocolFailure(event.isNull("session") ? ACK_SESSION_NULL : ACK_SESSION_TYPE); return; }
        if (!serverIdentityMatches(session, true)) return;
        state = State.CONFIGURING; phase = Phase.CONFIGURING;
        // Only this fixed successful send grants one acknowledgement on this engine/transport.
        // Reentrant ACK/cancel during send cannot gain or restore that authority.
        if (send(SESSION_UPDATE) && state == State.CONFIGURING) manualUpdatePending = true;
    }
    synchronized void sessionUpdated(JSONObject event) throws Exception {
        if (state == State.CLOSED || state == State.NEW) return;
        if (state != State.CONFIGURING || !manualUpdatePending) { protocolFailure(ACK_UNEXPECTED_SESSION_EVENT); return; }
        manualUpdatePending = false; // Consume before examining any acknowledgement fields.
        JSONObject session = event.optJSONObject("session");
        if (!serverIdentityMatches(session, false)) return;
        if (nestedTurnDetection(session)) { protocolFailure(ACK_NESTED_TURN_DETECTION); return; }
        boolean safe = GleamSpeechProtocol.safeAck(session);
        boolean omitted = session != null && !session.has("turn_detection");
        if (omitted) {
            // The sole compatibility delta: this pending manual request explicitly set null.
            // A shallow local copy preserves every other strict check without mutating the ACK.
            JSONObject manual = new JSONObject();
            for (Iterator<String> keys = session.keys(); keys.hasNext();) { String key = keys.next(); manual.put(key, session.opt(key)); }
            manual.put("turn_detection", JSONObject.NULL);
            safe = GleamSpeechProtocol.safeAck(manual);
        }
        if (!safe) {
            List<GleamSpeechProtocolReason> reasons = new ArrayList<>(GleamSpeechProtocol.ackReasons(event));
            if (omitted) reasons.remove(ACK_TURN_DETECTION_MISSING);
            if (reasons.isEmpty()) reasons.add(ACK_UNSAFE_CONFIGURATION);
            cancel("SPEECH_PROTOCOL", reasons); return;
        }
        clearDeadline();
        if (connectionOnly) { finish(); listener.connected(); return; }
        state = State.LISTENING; phase = Phase.MICROPHONE;
        try { audioStarted = true; audio.start(); }
        catch (Exception ignored) { cancel("SPEECH_AUDIO_UNAVAILABLE"); return; }
        if (state != State.LISTENING) return;
        listener.state("listening");
        armDeadline(30000, "SPEECH_LIMIT");
    }
    private boolean serverIdentityMatches(JSONObject session, boolean created) {
        if (session == null || !session.has("id")) return true;
        Object value = session.opt("id");
        if (!(value instanceof String)) { protocolFailure(ACK_SERVER_SESSION_ID_TYPE); return false; }
        String id = (String) value;
        if (!validItem(id)) { protocolFailure(ACK_SERVER_SESSION_ID_INVALID); return false; }
        if (!created && serverSessionId != null && !serverSessionId.equals(id)) { protocolFailure(ACK_SERVER_SESSION_ID_MISMATCH); return false; }
        if (created) serverSessionId = id;
        return true;
    }
    private static boolean nestedTurnDetection(JSONObject session) {
        JSONObject audio = session == null ? null : session.optJSONObject("audio");
        JSONObject input = audio == null ? null : audio.optJSONObject("input");
        return (audio != null && audio.has("turn_detection") && !audio.isNull("turn_detection"))
            || (input != null && input.has("turn_detection") && !input.isNull("turn_detection"));
    }
    synchronized void event(String type, String itemId, String text, int contentIndex) {
        if (state == State.CLOSED || state == State.NEW) return;
        if ("input_audio_buffer.speech_started".equals(type) || "input_audio_buffer.speech_stopped".equals(type)) { protocolFailure(UNEXPECTED_VAD_EVENT); return; }
        if ("response.created".equals(type)) { protocolFailure(UNEXPECTED_RESPONSE_EVENT); return; }
        if ("input_audio_buffer.committed".equals(type) && state == State.TRANSCRIBING) {
            if (!validItem(itemId)) { protocolFailure(GleamSpeechProtocolReason.COMMIT_ITEM_ID_INVALID); return; }
            if (committedItem != null && !committedItem.equals(itemId)) { protocolFailure(GleamSpeechProtocolReason.COMMIT_ITEM_ID_CONFLICT); return; }
            committedItem = itemId;
            if (pendingItem != null && pendingItem.equals(committedItem)) acceptTranscript(pendingText);
            pendingItem = null; pendingText = null;
        } else if ("conversation.item.input_audio_transcription.completed".equals(type) && state == State.TRANSCRIBING) {
            if (!validItem(itemId) || contentIndex != 0) return;
            if (text != null && text.length() > MAX_TRANSCRIPT_CHARS) { cancel("SPEECH_TRANSCRIPT_LIMIT"); return; }
            if (committedItem == null) {
                if (pendingItem != null && !pendingItem.equals(itemId)) { protocolFailure(GleamSpeechProtocolReason.TRANSCRIPT_ITEM_ID_CONFLICT); return; }
                pendingItem = itemId; pendingText = text;
            } else if (committedItem.equals(itemId)) acceptTranscript(text);
        } else if ("conversation.item.input_audio_transcription.failed".equals(type)) {
            cancel("SPEECH_TRANSCRIPTION_FAILED");
        }
        // Non-creation response output and partial input transcription never become input results.
    }
    /** Provider delta text + stash replaces the preview; only completed + committed can finish. */
    synchronized void partial(String itemId, String text, int contentIndex) {
        if ((state != State.LISTENING && state != State.TRANSCRIBING) || bytes == 0 || !validItem(itemId)
            || contentIndex != 0 || text == null || text.length() > MAX_TRANSCRIPT_CHARS) return;
        if (committedItem != null && !committedItem.equals(itemId)) return;
        if (previewItem != null && !previewItem.equals(itemId)) return;
        previewItem = itemId;
        listener.partial(text);
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
        state = State.TRANSCRIBING; phase = Phase.TRANSCRIBING;
        if (!send("{\"type\":\"input_audio_buffer.commit\"}")) return;
        listener.state("transcribing");
        armDeadline(15000, "SPEECH_TIMEOUT");
    }
    synchronized void cancel(String code) { cancel(code, Collections.emptyList()); }
    synchronized void protocolFailure(GleamSpeechProtocolReason reason) { cancel("SPEECH_PROTOCOL", Collections.singletonList(reason)); }
    synchronized void cancel(String code, List<GleamSpeechProtocolReason> reasons) {
        if (state == State.CLOSED) return;
        protocolReasons = "SPEECH_PROTOCOL".equals(code) ? GleamSpeechProtocolReason.bounded(reasons) : Collections.emptyList();
        finish(); listener.fail(code);
    }
    synchronized List<GleamSpeechProtocolReason> protocolReasons() { return protocolReasons; }
    synchronized boolean isClosed() { return state == State.CLOSED; }
    synchronized Phase phase() { return phase; }
    private boolean send(String message) {
        boolean accepted;
        try { accepted = transport.send(message); }
        catch (RuntimeException ignored) { accepted = false; }
        if (!accepted) cancel("SPEECH_NETWORK");
        return accepted;
    }
    private void armDeadline(long ms, String code) {
        clearDeadline();
        final long generation = deadlineGeneration;
        deadline = clock.after(ms, () -> {
            synchronized (GleamSpeechSession.this) {
                if (generation == deadlineGeneration && state != State.CLOSED) cancel(code);
            }
        });
    }
    private void clearDeadline() { deadlineGeneration++; if (deadline != null) { deadline.cancel(); deadline = null; } }
    private void stopAudio() { if (audioStarted) { audioStarted = false; try { audio.stop(); } catch (RuntimeException ignored) {} } }
    private void finish() { state = State.CLOSED; manualUpdatePending = false; serverSessionId = null; clearDeadline(); stopAudio(); try { transport.close(); } catch (RuntimeException ignored) {} committedItem = null; pendingItem = null; pendingText = null; bytes = 0; }
}

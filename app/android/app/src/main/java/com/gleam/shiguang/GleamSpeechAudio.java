package com.gleam.shiguang;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioRecordingConfiguration;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import java.util.Arrays;
import java.util.List;

/** In-memory PCM only; capture cannot resume after an interruption. */
final class GleamSpeechAudio implements GleamSpeechSession.Audio {
    interface Sink { void pcm(byte[] bytes, int length); void failure(String code); }
    private final AudioManager manager;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final GleamSpeechAuthorization authorization;
    private final Sink sink;
    private final GleamAudioRoute route;
    private final GleamPcmRates rates = new GleamPcmRates();
    private int inputRate = GleamSpeechSession.SAMPLE_RATE;
    private boolean starting;
    private Runnable readyCallback;
    private long routeDeadline;
    private final Runnable verifyRoute = this::verifyRoute;
    private volatile boolean running;
    private volatile AudioRecord recorder;
    private AudioFocusRequest focusRequest;
    private boolean focusGranted;
    private boolean callbackRegistered;
    private final AudioManager.OnAudioFocusChangeListener focus;
    private final AudioManager.AudioRecordingCallback recordingCallback = new AudioManager.AudioRecordingCallback() {
        @Override public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs) {
            AudioRecord current = recorder;
            if (Build.VERSION.SDK_INT >= 29 && current != null) {
                for (AudioRecordingConfiguration config : configs) {
                    if (config.getClientAudioSessionId() == current.getAudioSessionId() && config.isClientSilenced()) { sink.failure("SPEECH_INTERRUPTED"); return; }
                }
            }
        }
    };
    GleamSpeechAudio(Context context, GleamSpeechAuthorization authorization, Sink sink) {
        manager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE); this.authorization = authorization; this.sink = sink;
        route = new GleamAudioRoute(context, false, new GleamAudioRoute.Listener() { public void ready() { initialize(); } public void failed() { routeFailure(); } });
        focus = change -> {
            if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) sink.failure("SPEECH_INTERRUPTED");
        };
    }
    private boolean callActive() { return manager == null || manager.getMode() == AudioManager.MODE_IN_CALL || manager.getMode() == AudioManager.MODE_IN_COMMUNICATION; }
    @Override public void start() throws Exception { start(() -> {}); }
    @Override public synchronized void start(Runnable ready) throws Exception {
        if (running || starting) return;
        if (!authorization.allowed() || callActive()) throw new IllegalStateException("SPEECH_INTERRUPTED");
        try {
            starting = true; readyCallback = ready;
            int granted;
            if (Build.VERSION.SDK_INT >= 26) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                    .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setOnAudioFocusChangeListener(focus, main).setAcceptsDelayedFocusGain(false).build();
                granted = manager.requestAudioFocus(focusRequest);
            } else granted = manager.requestAudioFocus(focus, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE);
            if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) throw new IllegalStateException("SPEECH_INTERRUPTED");
            focusGranted = true; route.start();
        } catch (Exception error) { stop(); throw error; }
    }
    private synchronized void initialize() {
        if (!starting) return;
        try {
            if (!authorization.allowed() || !route.active()) throw new IllegalStateException();
            inputRate = route.legacyBluetooth() ? 8000 : GleamSpeechSession.SAMPLE_RATE;
            int minimum = AudioRecord.getMinBufferSize(inputRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minimum <= 0) throw new IllegalStateException();
            recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, inputRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum, inputRate * 2 / 5));
            AudioDeviceInfo input = route.inputDevice();
            if (input == null || recorder.getState() != AudioRecord.STATE_INITIALIZED || !recorder.setPreferredDevice(input)) throw new IllegalStateException();
            manager.registerAudioRecordingCallback(recordingCallback, main); callbackRegistered = true;
            final AudioRecord activating = recorder;
            authorization.activate(activating::startRecording);
            if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IllegalStateException();
            routeDeadline = android.os.SystemClock.elapsedRealtime() + 5000;
            main.post(verifyRoute);
        } catch (Exception ignored) { routeFailure(); }
    }
    private void verifyRoute() {
        Runnable ready; AudioRecord current;
        synchronized (this) {
            if (!starting) return;
            try {
                if (!authorization.allowed() || !route.active()) throw new IllegalStateException();
                if (!route.inputMatches(recorder.getRoutedDevice())) {
                    if (android.os.SystemClock.elapsedRealtime() >= routeDeadline) throw new IllegalStateException();
                    main.postDelayed(verifyRoute, 25); return;
                }
                AudioRecord input = recorder;
                if (!GleamAudioInputGate.discardPending(new GleamAudioInputGate.Input() {
                    public boolean routed() { return authorization.allowed() && route.active() && route.inputMatches(input.getRoutedDevice()); }
                    public int discard(byte[] bytes) { return input.read(bytes, 0, bytes.length, AudioRecord.READ_NON_BLOCKING); }
                }, Math.max(inputRate * 2 / 5, input.getBufferSizeInFrames() * 2))) throw new IllegalStateException();
                running = true; starting = false; current = recorder; ready = readyCallback; readyCallback = null;
            } catch (RuntimeException ignored) { routeFailure(); return; }
        }
        ready.run();
        new Thread(() -> capture(current), "gleam-short-voice").start();
    }
    private void routeFailure() { stop(); sink.failure("SPEECH_AUDIO_ROUTE"); }
    private void capture(AudioRecord current) {
        short[] samples = new short[inputRate == 8000 ? GleamSpeechSession.FRAME_BYTES / 4 : GleamSpeechSession.FRAME_BYTES / 2];
        byte[] bytes = new byte[samples.length * 2];
        try {
            while (running) {
                if (!authorization.allowed()) { sink.failure("SPEECH_INTERRUPTED"); break; }
                if (!route.active() || !route.inputMatches(current.getRoutedDevice())) { sink.failure("SPEECH_AUDIO_ROUTE"); break; }
                int count = current.read(samples, 0, samples.length, AudioRecord.READ_BLOCKING);
                if (!running) break;
                if (!authorization.allowed()) { sink.failure("SPEECH_INTERRUPTED"); break; }
                if (!route.active() || !route.inputMatches(current.getRoutedDevice())) { sink.failure("SPEECH_AUDIO_ROUTE"); break; }
                if (count <= 0) { sink.failure("SPEECH_AUDIO_UNAVAILABLE"); break; }
                for (int i = 0; i < count; i++) { bytes[i * 2] = (byte) samples[i]; bytes[i * 2 + 1] = (byte) (samples[i] >>> 8); }
                byte[] packet = inputRate == 8000 ? rates.input(bytes, count * 2) : bytes;
                sink.pcm(packet, inputRate == 8000 ? packet.length : count * 2);
                if (packet != bytes) Arrays.fill(packet, (byte) 0);
                Arrays.fill(bytes, (byte) 0); Arrays.fill(samples, (short) 0);
            }
        } catch (RuntimeException ignored) { if (running) sink.failure("SPEECH_AUDIO_UNAVAILABLE"); }
        finally { Arrays.fill(bytes, (byte) 0); Arrays.fill(samples, (short) 0); stop(); }
    }
    @Override public synchronized void stop() {
        running = starting = false; readyCallback = null; main.removeCallbacks(verifyRoute); rates.clear();
        AudioRecord current = recorder; recorder = null;
        if (current != null) {
            try { if (current.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) current.stop(); } catch (RuntimeException ignored) {}
            try { current.release(); } catch (RuntimeException ignored) {}
        }
        if (callbackRegistered) { callbackRegistered = false; try { manager.unregisterAudioRecordingCallback(recordingCallback); } catch (RuntimeException ignored) {} }
        route.close();
        if (focusGranted) {
            focusGranted = false;
            try {
                if (Build.VERSION.SDK_INT >= 26 && focusRequest != null) manager.abandonAudioFocusRequest(focusRequest);
                else manager.abandonAudioFocus(focus);
            } catch (RuntimeException ignored) {}
        }
        focusRequest = null;
    }
}

package com.gleam.shiguang;

import android.content.Context;
import android.media.AudioAttributes;
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
        focus = change -> {
            if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) sink.failure("SPEECH_INTERRUPTED");
        };
    }
    private boolean callActive() { return manager == null || manager.getMode() == AudioManager.MODE_IN_CALL || manager.getMode() == AudioManager.MODE_IN_COMMUNICATION; }
    @Override public synchronized void start() throws Exception {
        if (!authorization.allowed() || callActive()) throw new IllegalStateException("SPEECH_INTERRUPTED");
        int granted;
        if (Build.VERSION.SDK_INT >= 26) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setOnAudioFocusChangeListener(focus, main).setAcceptsDelayedFocusGain(false).build();
            granted = manager.requestAudioFocus(focusRequest);
        } else granted = manager.requestAudioFocus(focus, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE);
        if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) throw new IllegalStateException("SPEECH_INTERRUPTED");
        focusGranted = true;
        try {
            int minimum = AudioRecord.getMinBufferSize(GleamSpeechSession.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minimum <= 0) throw new IllegalStateException("SPEECH_AUDIO_UNAVAILABLE");
            recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, GleamSpeechSession.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum, GleamSpeechSession.FRAME_BYTES * 4));
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED || !authorization.allowed() || callActive()) throw new IllegalStateException("SPEECH_AUDIO_UNAVAILABLE");
            manager.registerAudioRecordingCallback(recordingCallback, main); callbackRegistered = true;
            // The last permission/revision check and microphone activation are one transaction with
            // native key rotation. A stale earlier mayCapture check cannot authorize this operation.
            final AudioRecord activating = recorder;
            authorization.activate(activating::startRecording);
            if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IllegalStateException("SPEECH_AUDIO_UNAVAILABLE");
            running = true;
            final AudioRecord current = recorder;
            new Thread(() -> capture(current), "gleam-short-voice").start();
        } catch (Exception error) { stop(); throw error; }
    }
    private void capture(AudioRecord current) {
        short[] samples = new short[GleamSpeechSession.FRAME_BYTES / 2];
        byte[] bytes = new byte[GleamSpeechSession.FRAME_BYTES];
        try {
            while (running) {
                if (!authorization.allowed() || callActive()) { sink.failure("SPEECH_INTERRUPTED"); break; }
                int count = current.read(samples, 0, samples.length, AudioRecord.READ_BLOCKING);
                if (!running) break;
                if (!authorization.allowed() || callActive()) { sink.failure("SPEECH_INTERRUPTED"); break; }
                if (count <= 0) { sink.failure("SPEECH_AUDIO_UNAVAILABLE"); break; }
                for (int i = 0; i < count; i++) { bytes[i * 2] = (byte) samples[i]; bytes[i * 2 + 1] = (byte) (samples[i] >>> 8); }
                sink.pcm(bytes, count * 2);
                Arrays.fill(bytes, (byte) 0); Arrays.fill(samples, (short) 0);
            }
        } catch (RuntimeException ignored) { if (running) sink.failure("SPEECH_AUDIO_UNAVAILABLE"); }
        finally { Arrays.fill(bytes, (byte) 0); Arrays.fill(samples, (short) 0); stop(); }
    }
    @Override public synchronized void stop() {
        running = false;
        AudioRecord current = recorder; recorder = null;
        if (current != null) {
            try { if (current.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) current.stop(); } catch (RuntimeException ignored) {}
            try { current.release(); } catch (RuntimeException ignored) {}
        }
        if (callbackRegistered) { callbackRegistered = false; try { manager.unregisterAudioRecordingCallback(recordingCallback); } catch (RuntimeException ignored) {} }
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

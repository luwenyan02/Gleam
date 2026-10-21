package com.gleam.shiguang;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** One microphone lease owns one communication route. Route changes end capture, never switch it silently. */
final class GleamAudioRoute {
    interface Listener { void ready(); void failed(); }
    private static final Object OWNER_LOCK = new Object();
    private static GleamAudioRoute owner;
    private final Context context;
    private final AudioManager manager;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final boolean duplex;
    private final Listener listener;
    private final Set<Integer> knownOutputs = new HashSet<>();
    private final GleamScoState sco = new GleamScoState();
    private AudioDeviceInfo selected, selectedInput;
    private boolean previousSpeaker, previousSco, modeOwned, communicationOwned, scoOwned;
    private boolean open, ready, failed, receiverRegistered, devicesRegistered, communicationRegistered;
    private final Runnable timeout = this::fail;
    private Api31 communication;
    private static final class Api31 {
        final AudioManager manager;
        final AudioManager.OnCommunicationDeviceChangedListener listener;
        Api31(AudioManager manager, Handler main, Runnable changed) {
            this.manager = manager; listener = device -> changed.run();
            manager.addOnCommunicationDeviceChangedListener(command -> main.post(command), listener);
        }
        void close() { manager.removeOnCommunicationDeviceChangedListener(listener); }
    }
    private void communicationChanged() {
        if (Build.VERSION.SDK_INT < 31) return;
        synchronized (OWNER_LOCK) {
            if (!open || failed || owner != this) return;
            try {
                AudioDeviceInfo device = manager.getCommunicationDevice();
                if (ready && (device == null || selected == null || device.getId() != selected.getId())) { fail(); return; }
                evaluate();
            } catch (RuntimeException ignored) { fail(); }
        }
    }
    private final AudioDeviceCallback devices = new AudioDeviceCallback() {
        @Override public void onAudioDevicesAdded(AudioDeviceInfo[] added) { changed(added, false); }
        @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) { changed(removed, true); }
    };
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context ignored, Intent intent) {
            synchronized (OWNER_LOCK) {
                if (!open || failed || owner != GleamAudioRoute.this) return;
                if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) { if (ready) fail(); return; }
                int state = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_DISCONNECTED);
                if (sco.observed(state)) { fail(); return; }
                if (scoOwned && sco.connected()) evaluate();
            }
        }
    };

    GleamAudioRoute(Context context, boolean duplex, Listener listener) {
        this.context = context.getApplicationContext(); this.duplex = duplex; this.listener = listener;
        manager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
    }

    void start() {
        synchronized (OWNER_LOCK) {
            if (open) return;
            if (manager == null || owner != null) { main.post(listener::failed); return; }
            owner = this; open = true;
            try {
                if (manager.getMode() == AudioManager.MODE_IN_CALL || manager.getMode() == AudioManager.MODE_IN_COMMUNICATION) { fail(); return; }
                previousSpeaker = manager.isSpeakerphoneOn(); previousSco = manager.isBluetoothScoOn();
                manager.setMode(AudioManager.MODE_IN_COMMUNICATION); modeOwned = true;
                for (AudioDeviceInfo device : manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) knownOutputs.add(device.getId());
                manager.registerAudioDeviceCallback(devices, main); devicesRegistered = true;
                IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
                if (Build.VERSION.SDK_INT < 31) filter.addAction(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED);
                Intent sticky;
                if (Build.VERSION.SDK_INT >= 33) sticky = context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
                else sticky = context.registerReceiver(receiver, filter);
                receiverRegistered = true;
                if (Build.VERSION.SDK_INT < 31 && sticky != null) sco.observed(sticky.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_DISCONNECTED));
                if (Build.VERSION.SDK_INT >= 31) {
                    communication = new Api31(manager, main, this::communicationChanged); communicationRegistered = true;
                }
                main.postDelayed(timeout, 30000);
                evaluate();
            } catch (RuntimeException ignored) { fail(); }
        }
    }

    private AudioDeviceInfo choose() {
        List<AudioDeviceInfo> candidates = Build.VERSION.SDK_INT >= 31 ? manager.getAvailableCommunicationDevices() : java.util.Arrays.asList(manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS));
        AudioDeviceInfo current = Build.VERSION.SDK_INT >= 31 ? manager.getCommunicationDevice() : null;
        if (current != null && GleamAudioRoutePolicy.external(current.getType())) {
            for (AudioDeviceInfo candidate : candidates) if (candidate.getId() == current.getId()) return candidate;
        }
        AudioDeviceInfo best = null;
        for (AudioDeviceInfo candidate : candidates) {
            if (GleamAudioRoutePolicy.priority(candidate.getType()) > (best == null ? 0 : GleamAudioRoutePolicy.priority(best.getType()))) best = candidate;
        }
        if (best != null) return best;
        // A2DP alone cannot record; wait for the HFP/BLE input rather than silently using the phone.
        if (bluetoothAttached()) return null;
        int fallback = duplex ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
        for (AudioDeviceInfo candidate : candidates) if (candidate.getType() == fallback) return candidate;
        for (AudioDeviceInfo candidate : candidates) if (candidate.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) return candidate;
        return null;
    }

    private boolean bluetoothAttached() {
        for (AudioDeviceInfo device : manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS))
            if (GleamAudioRoutePolicy.wirelessOutput(device.getType())) return true;
        return false;
    }
    private void requestSco() {
        if (scoOwned) return;
        if (!manager.isBluetoothScoAvailableOffCall()) { fail(); return; }
        manager.startBluetoothSco(); scoOwned = true; sco.requested();
    }

    private void evaluate() {
        if (!open || failed || owner != this || ready) return;
        try {
            if (selected == null) {
                selected = choose();
                if (selected == null) {
                    // Some older phones expose the SCO device only after SCO has connected.
                    if (Build.VERSION.SDK_INT < 31 && bluetoothAttached()) requestSco();
                    return;
                }
                if (Build.VERSION.SDK_INT >= 31) {
                    if (!manager.setCommunicationDevice(selected)) { fail(); return; }
                    communicationOwned = true;
                } else {
                    manager.setSpeakerphoneOn(selected.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER && duplex);
                    if (GleamAudioRoutePolicy.bluetooth(selected.getType())) {
                        requestSco(); if (!open) return;
                    }
                }
            }
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo actual = manager.getCommunicationDevice();
                if (actual == null || actual.getId() != selected.getId()) return;
            } else if (GleamAudioRoutePolicy.bluetooth(selected.getType())) {
                if (!sco.connected()) return;
                manager.setBluetoothScoOn(true);
            }
            selectedInput = inputDevice();
            if (selectedInput == null) return;
            ready = true; main.removeCallbacks(timeout);
            main.post(() -> { synchronized (OWNER_LOCK) { if (!open || failed || !ready || owner != this) return; } listener.ready(); });
        } catch (RuntimeException ignored) { fail(); }
    }

    private void changed(AudioDeviceInfo[] values, boolean removed) {
        synchronized (OWNER_LOCK) {
            if (!open || failed || owner != this) return;
            boolean externalChange = false;
            for (AudioDeviceInfo value : values) {
                if (removed && selectedInput != null && value.getId() == selectedInput.getId()) { fail(); return; }
                if (!value.isSink()) continue;
                boolean changed = removed ? knownOutputs.remove(value.getId()) : knownOutputs.add(value.getId());
                if (changed && (GleamAudioRoutePolicy.external(value.getType()) || GleamAudioRoutePolicy.wirelessOutput(value.getType()))) externalChange = true;
                if (removed && selected != null && value.getId() == selected.getId()) { fail(); return; }
            }
            if (ready && externalChange) { fail(); return; }
            evaluate();
        }
    }

    AudioDeviceInfo inputDevice() {
        if (selected == null) return null;
        AudioDeviceInfo matched = null, builtIn = null;
        for (AudioDeviceInfo input : manager.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            if (selectedInput != null) { if (input.getId() == selectedInput.getId()) return input; else continue; }
            if (input.getType() == AudioDeviceInfo.TYPE_BUILTIN_MIC) builtIn = input;
            if (GleamAudioRoutePolicy.inputMatches(selected.getType(), input.getType())) {
                // Do not override Android's matching source with an arbitrary second headset microphone.
                if (matched != null && GleamAudioRoutePolicy.bluetooth(selected.getType())) return null;
                matched = input;
            }
        }
        if (selectedInput != null) return null;
        return matched != null ? matched : GleamAudioRoutePolicy.bluetooth(selected.getType()) ? null : builtIn;
    }
    AudioDeviceInfo outputDevice() { return selected; }
    boolean legacyBluetooth() { return Build.VERSION.SDK_INT < 31 && selected != null && GleamAudioRoutePolicy.bluetooth(selected.getType()); }
    boolean inputMatches(AudioDeviceInfo device) { return selectedInput != null && device != null && selectedInput.getId() == device.getId(); }
    boolean outputMatches(AudioDeviceInfo device) { return selected != null && device != null && GleamAudioRoutePolicy.outputMatches(selected.getId(), device.getId()); }
    boolean active() {
        synchronized (OWNER_LOCK) {
            try {
                if (!open || failed || !ready || owner != this || manager.getMode() != AudioManager.MODE_IN_COMMUNICATION) return false;
                if (Build.VERSION.SDK_INT >= 31) { AudioDeviceInfo current = manager.getCommunicationDevice(); return current != null && outputMatches(current); }
                return !legacyBluetooth() || (sco.connected() && manager.isBluetoothScoOn());
            } catch (RuntimeException ignored) { return false; }
        }
    }
    private void fail() {
        synchronized (OWNER_LOCK) {
            if (!open || failed) return;
            failed = true; ready = false; main.removeCallbacks(timeout);
            // Stop the recorder/player before releasing the route, so queued speech cannot fall back to speaker.
            main.post(() -> { try { listener.failed(); } finally { close(); } });
        }
    }
    void close() {
        synchronized (OWNER_LOCK) {
            if (!open) return;
            open = ready = false; main.removeCallbacks(timeout);
            if (devicesRegistered) { devicesRegistered = false; try { manager.unregisterAudioDeviceCallback(devices); } catch (RuntimeException ignored) {} }
            if (receiverRegistered) { receiverRegistered = false; try { context.unregisterReceiver(receiver); } catch (RuntimeException ignored) {} }
            if (Build.VERSION.SDK_INT >= 31 && communicationRegistered) { communicationRegistered = false; try { communication.close(); } catch (RuntimeException ignored) {} communication = null; }
            if (owner != this) return;
            // Each cleanup is independent: a removed device or revoked permission must not skip the rest.
            boolean ownMode = false;
            try { ownMode = modeOwned && manager.getMode() == AudioManager.MODE_IN_COMMUNICATION; } catch (RuntimeException ignored) {}
            // Clear the app's accepted request even before it has become the actual route.
            if (Build.VERSION.SDK_INT >= 31 && communicationOwned) try { manager.clearCommunicationDevice(); } catch (RuntimeException ignored) {}
            if (scoOwned) try { manager.stopBluetoothSco(); } catch (RuntimeException ignored) {}
            if (ownMode && Build.VERSION.SDK_INT < 31) {
                if (scoOwned) try { if (manager.isBluetoothScoOn()) manager.setBluetoothScoOn(previousSco); } catch (RuntimeException ignored) {}
                try { if (manager.isSpeakerphoneOn() == (selected != null && selected.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER && duplex)) manager.setSpeakerphoneOn(previousSpeaker); } catch (RuntimeException ignored) {}
            }
            // MODE_NORMAL removes this process's request even when a phone call currently owns global mode.
            if (modeOwned) try { manager.setMode(AudioManager.MODE_NORMAL); } catch (RuntimeException ignored) {}
            modeOwned = communicationOwned = scoOwned = false; owner = null;
        }
    }
}

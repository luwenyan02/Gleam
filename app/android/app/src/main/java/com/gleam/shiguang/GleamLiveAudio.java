package com.gleam.shiguang;

import android.content.Context;
import android.media.*;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.NoiseSuppressor;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.List;

/** 16k mono capture / 24k mono playback. PCM stays in bounded memory and is never written to files. */
final class GleamLiveAudio implements GleamLiveVoiceSession.Audio {
    interface Sink { void pcm(byte[] bytes,int length); void failure(String code); void drained(); }
    private final AudioManager manager;
    private final GleamSpeechAuthorization authorization;
    private final Sink sink;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ArrayDeque<byte[]> queue=new ArrayDeque<>();
    private volatile boolean running,muted;
    private AudioRecord recorder;
    private AudioTrack player;
    private AudioFocusRequest focusRequest;
    private AcousticEchoCanceler echo;
    private NoiseSuppressor noise;
    private int generation,buffered,inFlight,previousMode;
    private long writtenFrames;
    private boolean focusGranted,modeOwned,previousSpeaker,recordingCallbackRegistered,finished;
    private final AudioManager.OnAudioFocusChangeListener focus;
    private final AudioManager.AudioRecordingCallback recordingCallback=new AudioManager.AudioRecordingCallback(){
        @Override public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs){
            synchronized(GleamLiveAudio.this){
                AudioRecord current=recorder;
                if(Build.VERSION.SDK_INT>=29&&current!=null)for(AudioRecordingConfiguration config:configs){
                    if(config.getClientAudioSessionId()==current.getAudioSessionId()&&config.isClientSilenced()){sink.failure("LIVE_INTERRUPTED");return;}
                }
            }
        }
    };
    GleamLiveAudio(Context context,GleamSpeechAuthorization authorization,Sink sink) {
        manager=(AudioManager)context.getSystemService(Context.AUDIO_SERVICE);this.authorization=authorization;this.sink=sink;
        focus=change->{if(change==AudioManager.AUDIOFOCUS_LOSS||change==AudioManager.AUDIOFOCUS_LOSS_TRANSIENT||change==AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)sink.failure("LIVE_INTERRUPTED");};
    }
    @Override public synchronized void start() throws Exception {
        if(running)return;
        if(!authorization.allowed()||manager==null||manager.getMode()==AudioManager.MODE_IN_CALL||manager.getMode()==AudioManager.MODE_IN_COMMUNICATION)throw new IllegalStateException("LIVE_INTERRUPTED");
        try {
            AudioAttributes attributes=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
            int granted;
            if(Build.VERSION.SDK_INT>=26){
                focusRequest=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE).setAudioAttributes(attributes).setOnAudioFocusChangeListener(focus,main).setAcceptsDelayedFocusGain(false).build();
                granted=manager.requestAudioFocus(focusRequest);
            }else granted=manager.requestAudioFocus(focus,AudioManager.STREAM_VOICE_CALL,AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE);
            if(granted!=AudioManager.AUDIOFOCUS_REQUEST_GRANTED)throw new IllegalStateException("LIVE_INTERRUPTED");focusGranted=true;
            previousMode=manager.getMode();previousSpeaker=manager.isSpeakerphoneOn();manager.setMode(AudioManager.MODE_IN_COMMUNICATION);modeOwned=true;
            boolean external=false;
            for(AudioDeviceInfo device:manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)){
                int type=device.getType();if(type==AudioDeviceInfo.TYPE_WIRED_HEADSET||type==AudioDeviceInfo.TYPE_WIRED_HEADPHONES||type==AudioDeviceInfo.TYPE_BLUETOOTH_SCO||type==AudioDeviceInfo.TYPE_BLUETOOTH_A2DP||type==AudioDeviceInfo.TYPE_USB_HEADSET||(Build.VERSION.SDK_INT>=31&&type==AudioDeviceInfo.TYPE_BLE_HEADSET))external=true;
            }
            manager.setSpeakerphoneOn(!external);
            int inputMin=AudioRecord.getMinBufferSize(16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT);
            int outputMin=AudioTrack.getMinBufferSize(24000,AudioFormat.CHANNEL_OUT_MONO,AudioFormat.ENCODING_PCM_16BIT);
            if(inputMin<=0||outputMin<=0)throw new IllegalStateException("LIVE_AUDIO");
            recorder=new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION,16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT,Math.max(inputMin,5120));
            player=new AudioTrack.Builder().setAudioAttributes(attributes).setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(24000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()).setBufferSizeInBytes(Math.max(outputMin,9600)).setTransferMode(AudioTrack.MODE_STREAM).build();
            if(recorder.getState()!=AudioRecord.STATE_INITIALIZED||player.getState()!=AudioTrack.STATE_INITIALIZED)throw new IllegalStateException("LIVE_AUDIO");
            if(AcousticEchoCanceler.isAvailable()){echo=AcousticEchoCanceler.create(recorder.getAudioSessionId());if(echo!=null)echo.setEnabled(true);}
            if(NoiseSuppressor.isAvailable()){noise=NoiseSuppressor.create(recorder.getAudioSessionId());if(noise!=null)noise.setEnabled(true);}
            manager.registerAudioRecordingCallback(recordingCallback,main);recordingCallbackRegistered=true;
            authorization.activate(()->{recorder.startRecording();player.play();});
            if(recorder.getRecordingState()!=AudioRecord.RECORDSTATE_RECORDING)throw new IllegalStateException("LIVE_AUDIO");
            running=true;AudioRecord current=recorder;
            new Thread(()->capture(current),"gleam-live-capture").start();new Thread(this::playback,"gleam-live-playback").start();
        }catch(SecurityException error){stop();throw error;}
        catch(Exception error){stop();throw error;}
    }
    private void capture(AudioRecord current){
        byte[] bytes=new byte[640];
        try {
            while(running){
                if(!authorization.allowed()||manager.getMode()==AudioManager.MODE_IN_CALL){sink.failure("LIVE_INTERRUPTED");break;}
                int n=current.read(bytes,0,bytes.length,AudioRecord.READ_BLOCKING);
                if(!running)break;
                if(n<=0||n%2!=0){sink.failure("LIVE_AUDIO");break;}
                if(!muted&&authorization.allowed())sink.pcm(bytes,n);
                Arrays.fill(bytes,(byte)0);
            }
        }catch(RuntimeException ignored){if(running)sink.failure("LIVE_AUDIO");}
        finally{Arrays.fill(bytes,(byte)0);stop();}
    }
    private void playback(){
        while(running){
            byte[] frame=null;int epoch=0;
            try {
                boolean drained=false;
                synchronized(this){
                    if(!authorization.allowed()){sink.failure("LIVE_INTERRUPTED");return;}
                    if(!queue.isEmpty()){frame=queue.removeFirst();buffered-=frame.length;inFlight=frame.length;epoch=generation;}
                    else if(finished&&!playing()){finished=false;drained=true;}
                    else wait(15);
                }
                if(drained)sink.drained();
                if(frame==null)continue;
                int offset=0;int[] written=new int[1];
                while(running&&offset<frame.length){
                    int n;
                    synchronized(this){
                        if(epoch!=generation||player==null||!authorization.allowed())break;
                        byte[] currentFrame=frame;int position=offset;
                        authorization.activate(()->written[0]=player.write(currentFrame,position,Math.min(960,currentFrame.length-position),AudioTrack.WRITE_NON_BLOCKING));
                        n=written[0];
                        if(n>0){writtenFrames+=n/2;inFlight-=n;}
                    }
                    if(n<0){sink.failure("LIVE_AUDIO");return;}
                    if(n==0)Thread.sleep(10);else offset+=n;
                }
            }catch(InterruptedException ignored){Thread.currentThread().interrupt();return;}
            catch(RuntimeException ignored){if(running)sink.failure("LIVE_AUDIO");return;}
            finally{if(frame!=null){Arrays.fill(frame,(byte)0);synchronized(this){if(epoch==generation)inFlight=0;}}}
        }
    }
    @Override public synchronized void play(byte[] bytes){
        if(!running){Arrays.fill(bytes,(byte)0);return;}
        if(buffered+bytes.length>1440000){Arrays.fill(bytes,(byte)0);sink.failure("LIVE_LIMIT");return;}
        queue.addLast(bytes);buffered+=bytes.length;finished=false;notifyAll();
    }
    @Override public synchronized void clear(){
        generation++;for(byte[] bytes:queue)Arrays.fill(bytes,(byte)0);queue.clear();buffered=0;inFlight=0;writtenFrames=0;finished=false;
        if(player!=null)try{player.pause();player.flush();if(running)player.play();}catch(RuntimeException ignored){sink.failure("LIVE_AUDIO");}
        notifyAll();
    }
    @Override public void mute(boolean value){muted=value;}
    @Override public synchronized boolean playing(){
        if(!queue.isEmpty()||inFlight>0)return true;
        return player!=null&&(player.getPlaybackHeadPosition()&0xffffffffL)<writtenFrames;
    }
    @Override public synchronized void finish(){finished=true;notifyAll();}
    @Override public synchronized void stop(){
        running=false;generation++;notifyAll();for(byte[] bytes:queue)Arrays.fill(bytes,(byte)0);queue.clear();buffered=0;inFlight=0;writtenFrames=0;finished=false;
        AudioRecord input=recorder;recorder=null;AudioTrack output=player;player=null;
        if(input!=null){try{input.stop();}catch(RuntimeException ignored){}try{input.release();}catch(RuntimeException ignored){}}
        if(output!=null){try{output.pause();output.flush();output.stop();}catch(RuntimeException ignored){}try{output.release();}catch(RuntimeException ignored){}}
        if(echo!=null){try{echo.release();}catch(RuntimeException ignored){}echo=null;}
        if(noise!=null){try{noise.release();}catch(RuntimeException ignored){}noise=null;}
        if(recordingCallbackRegistered){recordingCallbackRegistered=false;try{manager.unregisterAudioRecordingCallback(recordingCallback);}catch(RuntimeException ignored){}}
        if(modeOwned){modeOwned=false;try{manager.setSpeakerphoneOn(previousSpeaker);manager.setMode(previousMode);}catch(RuntimeException ignored){}}
        if(focusGranted){focusGranted=false;try{if(Build.VERSION.SDK_INT>=26)manager.abandonAudioFocusRequest(focusRequest);else manager.abandonAudioFocus(focus);}catch(RuntimeException ignored){}}
        focusRequest=null;
    }
}

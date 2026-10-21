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
    private final GleamAudioRoute route;
    private final GleamPcmRates rates=new GleamPcmRates();
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ArrayDeque<byte[]> queue=new ArrayDeque<>();
    private volatile boolean running,muted;
    private AudioRecord recorder;
    private AudioTrack player;
    private AudioFocusRequest focusRequest;
    private AcousticEchoCanceler echo;
    private NoiseSuppressor noise;
    private int generation,buffered,inFlight,inputRate=16000,outputRate=24000;
    private boolean starting;
    private Runnable readyCallback;
    private long routeDeadline;
    private final Runnable verifyRoute=this::verifyRoute;
    private long writtenFrames;
    private boolean focusGranted,recordingCallbackRegistered,finished;
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
        route=new GleamAudioRoute(context,true,new GleamAudioRoute.Listener(){public void ready(){initialize();}public void failed(){routeFailure();}});
        focus=change->{if(change==AudioManager.AUDIOFOCUS_LOSS||change==AudioManager.AUDIOFOCUS_LOSS_TRANSIENT||change==AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)sink.failure("LIVE_INTERRUPTED");};
    }
    @Override public void start() throws Exception { start(()->{}); }
    @Override public synchronized void start(Runnable ready) throws Exception {
        if(running||starting)return;
        if(!authorization.allowed()||manager==null||manager.getMode()==AudioManager.MODE_IN_CALL||manager.getMode()==AudioManager.MODE_IN_COMMUNICATION)throw new IllegalStateException("LIVE_INTERRUPTED");
        try {
            starting=true;readyCallback=ready;
            AudioAttributes attributes=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
            int granted;
            if(Build.VERSION.SDK_INT>=26){
                focusRequest=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE).setAudioAttributes(attributes).setOnAudioFocusChangeListener(focus,main).setAcceptsDelayedFocusGain(false).build();
                granted=manager.requestAudioFocus(focusRequest);
            }else granted=manager.requestAudioFocus(focus,AudioManager.STREAM_VOICE_CALL,AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE);
            if(granted!=AudioManager.AUDIOFOCUS_REQUEST_GRANTED)throw new IllegalStateException("LIVE_INTERRUPTED");focusGranted=true;
            route.start();
        }catch(Exception error){stop();throw error;}
    }
    private void initialize(){
        synchronized(this){
            if(!starting)return;
            try{
                if(!authorization.allowed()||!route.active())throw new IllegalStateException();
                inputRate=route.legacyBluetooth()?8000:16000;outputRate=route.legacyBluetooth()?8000:24000;
                int inputMin=AudioRecord.getMinBufferSize(inputRate,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT);
                int outputMin=AudioTrack.getMinBufferSize(outputRate,AudioFormat.CHANNEL_OUT_MONO,AudioFormat.ENCODING_PCM_16BIT);
                if(inputMin<=0||outputMin<=0)throw new IllegalStateException();
                recorder=new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION,inputRate,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT,Math.max(inputMin,inputRate/4));
                AudioAttributes attributes=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
                player=new AudioTrack.Builder().setAudioAttributes(attributes).setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(outputRate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()).setBufferSizeInBytes(Math.max(outputMin,outputRate*2/5)).setTransferMode(AudioTrack.MODE_STREAM).build();
                AudioDeviceInfo input=route.inputDevice(),output=route.outputDevice();
                if(input==null||output==null||recorder.getState()!=AudioRecord.STATE_INITIALIZED||player.getState()!=AudioTrack.STATE_INITIALIZED
                    ||!recorder.setPreferredDevice(input)||!player.setPreferredDevice(output))throw new IllegalStateException();
                if(AcousticEchoCanceler.isAvailable()){echo=AcousticEchoCanceler.create(recorder.getAudioSessionId());if(echo!=null)echo.setEnabled(true);}
                if(NoiseSuppressor.isAvailable()){noise=NoiseSuppressor.create(recorder.getAudioSessionId());if(noise!=null)noise.setEnabled(true);}
                manager.registerAudioRecordingCallback(recordingCallback,main);recordingCallbackRegistered=true;
                authorization.activate(()->{recorder.startRecording();player.play();});
                if(recorder.getRecordingState()!=AudioRecord.RECORDSTATE_RECORDING)throw new IllegalStateException();
                // Silence activates the output so actual routing can be checked before any reply audio.
                byte[] silence=new byte[outputRate/50*2];int primed=player.write(silence,0,silence.length,AudioTrack.WRITE_NON_BLOCKING);
                if(primed<0)throw new IllegalStateException();writtenFrames=primed/2;
                routeDeadline=android.os.SystemClock.elapsedRealtime()+5000;
                main.post(verifyRoute);
            }catch(Exception ignored){routeFailure();}
        }
    }
    private void verifyRoute(){
        Runnable ready;AudioRecord current;
        synchronized(this){
            if(!starting)return;
            try{
                if(!authorization.allowed()||!route.active())throw new IllegalStateException();
                if(!route.inputMatches(recorder.getRoutedDevice())||!route.outputMatches(player.getRoutedDevice())){
                    if(android.os.SystemClock.elapsedRealtime()>=routeDeadline)throw new IllegalStateException();
                    if(player.getRoutedDevice()==null){
                        byte[] silence=new byte[outputRate/50*2];int n=player.write(silence,0,silence.length,AudioTrack.WRITE_NON_BLOCKING);
                        if(n<0)throw new IllegalStateException();writtenFrames+=n/2;
                    }
                    main.postDelayed(verifyRoute,25);return;
                }
                AudioRecord input=recorder;
                if(!GleamAudioInputGate.discardPending(new GleamAudioInputGate.Input(){
                    public boolean routed(){return authorization.allowed()&&route.active()&&route.inputMatches(input.getRoutedDevice());}
                    public int discard(byte[] bytes){return input.read(bytes,0,bytes.length,AudioRecord.READ_NON_BLOCKING);}
                },Math.max(inputRate*2/5,input.getBufferSizeInFrames()*2)))throw new IllegalStateException();
                starting=false;running=true;ready=readyCallback;readyCallback=null;current=recorder;
            }catch(RuntimeException ignored){routeFailure();return;}
        }
        ready.run();
        new Thread(()->capture(current),"gleam-live-capture").start();new Thread(this::playback,"gleam-live-playback").start();
    }
    private void routeFailure(){stop();sink.failure("LIVE_AUDIO_ROUTE");}
    private void capture(AudioRecord current){
        byte[] bytes=new byte[inputRate/50*2];
        try {
            while(running){
                if(!authorization.allowed()){sink.failure("LIVE_INTERRUPTED");break;}
                if(!route.active()||!route.inputMatches(current.getRoutedDevice())){sink.failure("LIVE_AUDIO_ROUTE");break;}
                int n=current.read(bytes,0,bytes.length,AudioRecord.READ_BLOCKING);
                if(!running)break;
                if(n<=0||n%2!=0){sink.failure("LIVE_AUDIO");break;}
                if(!route.active()||!route.inputMatches(current.getRoutedDevice())){sink.failure("LIVE_AUDIO_ROUTE");break;}
                if(!muted&&authorization.allowed()){byte[] packet=inputRate==8000?rates.input(bytes,n):bytes;sink.pcm(packet,inputRate==8000?packet.length:n);if(packet!=bytes)Arrays.fill(packet,(byte)0);}
                Arrays.fill(bytes,(byte)0);
            }
        }catch(RuntimeException ignored){if(running)sink.failure("LIVE_AUDIO");}
        finally{Arrays.fill(bytes,(byte)0);stop();}
    }
    private void playback(){
        byte[] silence=new byte[outputRate/50*2];
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
                int offset=0;int[] written=new int[1];GleamPlaybackRouteGate gate=new GleamPlaybackRouteGate();
                while(running&&offset<frame.length){
                    int n;boolean priming;
                    synchronized(this){
                        if(!running||epoch!=generation||player==null||!authorization.allowed())break;
                        AudioDeviceInfo actual=player.getRoutedDevice();
                        GleamPlaybackRouteGate.Action action=gate.poll(route.active(),actual==null,route.outputMatches(actual),android.os.SystemClock.elapsedRealtime());
                        if(action==GleamPlaybackRouteGate.Action.FAIL){sink.failure("LIVE_AUDIO_ROUTE");return;}
                        priming=action==GleamPlaybackRouteGate.Action.PRIME;
                        if(priming)authorization.activate(()->written[0]=player.write(silence,0,silence.length,AudioTrack.WRITE_NON_BLOCKING));
                        else{
                            byte[] currentFrame=frame;int position=offset;
                            authorization.activate(()->written[0]=player.write(currentFrame,position,Math.min(960,currentFrame.length-position),AudioTrack.WRITE_NON_BLOCKING));
                        }
                        n=written[0];
                        if(n>0){writtenFrames+=n/2;if(!priming)inFlight-=n;}
                    }
                    if(n<0){sink.failure("LIVE_AUDIO");return;}
                    if(priming){Thread.sleep(25);continue;}
                    if(n==0)Thread.sleep(10);else offset+=n;
                }
            }catch(InterruptedException ignored){Thread.currentThread().interrupt();return;}
            catch(RuntimeException ignored){if(running)sink.failure("LIVE_AUDIO");return;}
            finally{if(frame!=null){Arrays.fill(frame,(byte)0);synchronized(this){if(epoch==generation)inFlight=0;}}}
        }
    }
    @Override public synchronized void play(byte[] bytes){
        if(!running){Arrays.fill(bytes,(byte)0);return;}
        if(outputRate==8000){byte[] original=bytes;bytes=rates.output(original);Arrays.fill(original,(byte)0);}
        if(bytes.length==0)return;
        if(buffered+bytes.length>outputRate*2*30){Arrays.fill(bytes,(byte)0);sink.failure("LIVE_LIMIT");return;}
        queue.addLast(bytes);buffered+=bytes.length;finished=false;notifyAll();
    }
    @Override public synchronized void clear(){
        generation++;rates.clear();for(byte[] bytes:queue)Arrays.fill(bytes,(byte)0);queue.clear();buffered=0;inFlight=0;writtenFrames=0;finished=false;
        if(player!=null)try{player.pause();player.flush();if(running)player.play();}catch(RuntimeException ignored){sink.failure("LIVE_AUDIO");}
        notifyAll();
    }
    @Override public void mute(boolean value){muted=value;}
    @Override public synchronized boolean playing(){
        if(!queue.isEmpty()||inFlight>0)return true;
        return player!=null&&(player.getPlaybackHeadPosition()&0xffffffffL)<writtenFrames;
    }
    @Override public synchronized void finish(){if(outputRate==8000){byte[] tail=rates.finishOutput();if(tail.length>0){queue.addLast(tail);buffered+=tail.length;}}finished=true;notifyAll();}
    @Override public synchronized void stop(){
        running=starting=false;readyCallback=null;main.removeCallbacks(verifyRoute);rates.clear();generation++;notifyAll();for(byte[] bytes:queue)Arrays.fill(bytes,(byte)0);queue.clear();buffered=0;inFlight=0;writtenFrames=0;finished=false;
        AudioRecord input=recorder;recorder=null;AudioTrack output=player;player=null;
        if(input!=null){try{input.stop();}catch(RuntimeException ignored){}try{input.release();}catch(RuntimeException ignored){}}
        if(output!=null){try{output.pause();output.flush();output.stop();}catch(RuntimeException ignored){}try{output.release();}catch(RuntimeException ignored){}}
        if(echo!=null){try{echo.release();}catch(RuntimeException ignored){}echo=null;}
        if(noise!=null){try{noise.release();}catch(RuntimeException ignored){}noise=null;}
        if(recordingCallbackRegistered){recordingCallbackRegistered=false;try{manager.unregisterAudioRecordingCallback(recordingCallback);}catch(RuntimeException ignored){}}
        route.close();
        if(focusGranted){focusGranted=false;try{if(Build.VERSION.SDK_INT>=26)manager.abandonAudioFocusRequest(focusRequest);else manager.abandonAudioFocus(focus);}catch(RuntimeException ignored){}}
        focusRequest=null;
    }
}

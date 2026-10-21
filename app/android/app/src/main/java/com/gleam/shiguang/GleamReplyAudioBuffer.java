package com.gleam.shiguang;

import java.io.*;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.nio.ByteBuffer;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** One serial network producer / one playback consumer. Only replies enter this encrypted spool. */
final class GleamReplyAudioBuffer {
    static final int MAX_PENDING_BYTES=262144, RECORD_BYTES=65536;
    private static final Budget GLOBAL=new Budget(384L*1024*1024);
    private static final String PROCESS=UUID.randomUUID().toString()+"-";
    private static final SecureRandom RANDOM=new SecureRandom();
    private static final Set<String> CLEANED=new HashSet<>();
    private static final ExecutorService CLEANUP=Executors.newSingleThreadExecutor(work->{Thread thread=new Thread(work,"gleam-reply-cleanup");thread.setDaemon(true);return thread;});
    interface Io { default void beforeWrite() throws IOException {} default void beforeRead() throws IOException {} }
    static final class Failure extends IOException {
        final long generation;
        Failure(long generation,IOException cause){super("Reply cache unavailable",cause);this.generation=generation;}
    }
    static final class Budget {
        final long limit;private long used;
        Budget(long limit){this.limit=limit;}
        synchronized void reserve(long bytes) throws IOException {if(bytes>limit-used)throw new IOException("Reply cache full");used+=bytes;}
        synchronized void release(long bytes){used-=bytes;}
        synchronized long used(){return used;}
    }
    private static final class Generation {
        final long id;final Object writer=new Object(),reader=new Object();
        final Set<Write> pending=new HashSet<>();
        long end,read,diskBytes,nonce;int leases,pendingBytes;
        boolean retired,sealed,checkedOut,cleanup;
        File file;byte[] key;Frame frame;
        Generation(long id){this.id=id;}
    }
    final class Write {
        final long generation;private final Generation owner;private final byte[] bytes;private boolean started,done;
        Write(Generation owner,byte[] bytes){this.owner=owner;this.bytes=bytes;generation=owner.id;}
        void append() throws IOException {
            synchronized(GleamReplyAudioBuffer.this){
                if(done||started)return;
                if(owner.retired){discard(this);return;}
                started=true;owner.leases++;
            }
            try {
                synchronized(owner.writer){
                    if(!current(generation))return;
                    ensureFile(owner);io.beforeWrite();
                    try(RandomAccessFile output=new RandomAccessFile(owner.file,"rw")){
                        for(int position=0;position<bytes.length;position+=RECORD_BYTES){
                            if(!current(generation))return;
                            int length=Math.min(RECORD_BYTES,bytes.length-position);byte[] nonce=ByteBuffer.allocate(12).putInt(0).putLong(owner.nonce++).array();
                            long offset; synchronized(GleamReplyAudioBuffer.this){offset=owner.end;}
                            byte[] encrypted=crypt(Cipher.ENCRYPT_MODE,owner.key,nonce,bytes,position,length,offset);
                            long cost=4+nonce.length+encrypted.length;budget.reserve(cost);owner.diskBytes+=cost;
                            output.seek(offset);output.writeInt(length);output.write(nonce);output.write(encrypted);
                            synchronized(GleamReplyAudioBuffer.this){owner.end=offset+cost;}
                        }
                    }
                }
            } finally {
                synchronized(GleamReplyAudioBuffer.this){discard(this);owner.leases--;retireIfIdle(owner);}
            }
        }
    }
    static final class Frame {
        final long generation;final byte[] bytes;private final Generation owner;
        Frame(Generation owner,byte[] bytes){this.owner=owner;generation=owner.id;this.bytes=bytes;}
    }
    private final File directory;private final Budget budget;private final Io io;
    private Generation current=new Generation(0);private boolean closed;private int maxPlaintext;
    GleamReplyAudioBuffer(File directory){this(directory,GLOBAL,new Io(){});}
    GleamReplyAudioBuffer(File directory,Budget budget,Io io){this.directory=directory;this.budget=budget;this.io=io;CLEANUP.execute(()->{try{cleanStale();}catch(IOException ignored){}});}
    synchronized Write reserve(byte[] bytes) throws IOException {
        if(closed||bytes.length==0||bytes.length%2!=0||bytes.length>MAX_PENDING_BYTES-current.pendingBytes){Arrays.fill(bytes,(byte)0);throw new IOException("Invalid reply cache reservation");}
        Write write=new Write(current,bytes);current.pending.add(write);current.pendingBytes+=bytes.length;current.sealed=false;
        maxPlaintext=Math.max(maxPlaintext,current.pendingBytes+(current.frame==null?0:current.frame.bytes.length));return write;
    }
    private void discard(Write write){
        if(write.done)return;write.done=true;Arrays.fill(write.bytes,(byte)0);
        if(write.owner.pending.remove(write))write.owner.pendingBytes-=write.bytes.length;
    }
    synchronized boolean current(long generation){return !closed&&current.id==generation;}
    synchronized long generation(){return current.id;}
    synchronized int maxPlaintextBytes(){return maxPlaintext;}
    synchronized boolean playing(){return !closed&&(!current.pending.isEmpty()||current.read<current.end||current.checkedOut);}
    synchronized boolean drained(){return !closed&&current.sealed&&!playing();}
    synchronized void finish(){if(!closed)current.sealed=true;}
    synchronized void clear(){
        if(closed)return;Generation old=current;current=new Generation(old.id+1);retire(old);
    }
    synchronized void close(){if(closed)return;closed=true;retire(current);}
    private void retire(Generation owner){
        owner.retired=true;
        for(Write write:new ArrayList<>(owner.pending))if(!write.started)discard(write);
        if(owner.frame!=null)Arrays.fill(owner.frame.bytes,(byte)0);
        retireIfIdle(owner);
    }
    private void retireIfIdle(Generation owner){
        if(!owner.retired||owner.leases!=0||owner.cleanup)return;owner.cleanup=true;
        if(owner.key!=null)Arrays.fill(owner.key,(byte)0);
        if(owner.file!=null)CLEANUP.execute(()->{if(owner.file.delete()||!owner.file.exists())budget.release(owner.diskBytes);});
    }
    Frame read() throws IOException {
        Generation owner;long offset;
        synchronized(this){
            if(closed||current.checkedOut||current.read==current.end)return null;
            owner=current;offset=owner.read;owner.checkedOut=true;owner.leases++;
        }
        byte[] plain=null;boolean returned=false;
        try {
            synchronized(owner.reader){
                io.beforeRead();
                try(RandomAccessFile input=new RandomAccessFile(owner.file,"r")){
                    input.seek(offset);int length=input.readInt();
                    if(length<=0||length>RECORD_BYTES||length%2!=0)throw new IOException("Invalid reply cache record");
                    byte[] nonce=new byte[12],encrypted=new byte[length+16];input.readFully(nonce);input.readFully(encrypted);
                    plain=crypt(Cipher.DECRYPT_MODE,owner.key,nonce,encrypted,0,encrypted.length,offset);
                    synchronized(this){
                        if(!current(owner.id))return null;
                        owner.read=offset+4+12+encrypted.length;Frame frame=new Frame(owner,plain);owner.frame=frame;
                        maxPlaintext=Math.max(maxPlaintext,owner.pendingBytes+plain.length);returned=true;return frame;
                    }
                }
            }
        } catch(IOException error){if(current(owner.id))throw new Failure(owner.id,error);return null;}
        finally {
            synchronized(this){if(!returned){if(plain!=null)Arrays.fill(plain,(byte)0);owner.checkedOut=false;}owner.leases--;retireIfIdle(owner);}
        }
    }
    synchronized void release(Frame frame){
        Arrays.fill(frame.bytes,(byte)0);if(frame.owner.frame==frame){frame.owner.frame=null;frame.owner.checkedOut=false;}
    }
    private void ensureFile(Generation owner) throws IOException {
        if(owner.file!=null)return;
        cleanStale();
        owner.file=File.createTempFile(PROCESS,".gcm",directory);owner.key=new byte[32];RANDOM.nextBytes(owner.key);
    }
    private void cleanStale() throws IOException {
        synchronized(CLEANED){
            String path=directory.getAbsolutePath();
            if(!CLEANED.contains(path)){
                if(!directory.mkdirs()&&!directory.isDirectory())throw new IOException("Reply cache unavailable");
                File[] files=directory.listFiles();if(files==null)throw new IOException("Reply cache unavailable");
                for(File file:files)if(file.getName().endsWith(".gcm")&&!file.getName().startsWith(PROCESS)&&!file.delete())throw new IOException("Reply cache cleanup failed");
                CLEANED.add(path);
            }
        }
    }
    private static byte[] crypt(int mode,byte[] key,byte[] nonce,byte[] data,int offset,int length,long recordOffset) throws IOException {
        try{Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(mode,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,nonce));cipher.updateAAD(ByteBuffer.allocate(8).putLong(recordOffset).array());return cipher.doFinal(data,offset,length);}
        catch(GeneralSecurityException error){throw new IOException("Reply cache encryption failed",error);}
    }
}

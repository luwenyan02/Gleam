package com.gleam.shiguang;

import static org.junit.Assert.*;
import java.io.*;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.*;
import org.junit.Test;

public class GleamReplyAudioBufferTest {
    private File directory() throws IOException {
        File root=new File(System.getProperty("user.dir"),".tmp/tests/reply-audio");
        assertTrue(root.mkdirs()||root.isDirectory());
        return Files.createTempDirectory(root.toPath(),"case-").toFile();
    }
    private void emptyEventually(File directory) throws Exception {
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);
        while(directory.list().length!=0&&System.nanoTime()<deadline)Thread.sleep(5);
        assertEquals(0,directory.list().length);
    }
    private byte[] packet(int index) {
        byte[] data=new byte[4800];for(int j=0;j<data.length;j++)data[j]=(byte)(index*31+j*7);return data;
    }
    @Test public void fastTwoMinuteReplyAndSlowConsumerKeepEveryByteWithBoundedPlaintext() throws Exception {
        File dir=directory();GleamReplyAudioBuffer buffer=new GleamReplyAudioBuffer(dir);
        MessageDigest expected=MessageDigest.getInstance("SHA-256"),actual=MessageDigest.getInstance("SHA-256");
        for(int i=0;i<1200;i++){byte[] pcm=packet(i);expected.update(pcm);buffer.reserve(pcm).append();assertArrayEquals(new byte[pcm.length],pcm);}
        buffer.finish();assertTrue(buffer.playing());assertFalse(buffer.drained());
        long bytes=0;GleamReplyAudioBuffer.Frame frame;
        while((frame=buffer.read())!=null){actual.update(frame.bytes);bytes+=frame.bytes.length;assertTrue(buffer.playing());assertTrue(frame.bytes.length<=65536);buffer.release(frame);}
        assertEquals(5760000,bytes);assertArrayEquals(expected.digest(),actual.digest());assertTrue(buffer.drained());
        assertTrue(buffer.maxPlaintextBytes()<=GleamReplyAudioBuffer.MAX_PENDING_BYTES+65536);
        buffer.close();emptyEventually(dir);
    }
    @Test public void pendingWriteAndCheckedOutFramePreventEarlyDrain() throws Exception {
        File dir=directory();GleamReplyAudioBuffer buffer=new GleamReplyAudioBuffer(dir);
        GleamReplyAudioBuffer.Write write=buffer.reserve(packet(1));buffer.finish();
        assertTrue(buffer.playing());assertFalse(buffer.drained());assertNull(buffer.read());
        write.append();GleamReplyAudioBuffer.Frame frame=buffer.read();assertNotNull(frame);
        assertFalse(buffer.drained());buffer.release(frame);assertTrue(buffer.drained());buffer.close();emptyEventually(dir);
    }
    @Test public void clearAndCloseNeverWaitForBlockedWriteAndOldWriteCannotEnterNewGeneration() throws Exception {
        File dir=directory();CountDownLatch entered=new CountDownLatch(1),resume=new CountDownLatch(1);
        GleamReplyAudioBuffer buffer=new GleamReplyAudioBuffer(dir,new GleamReplyAudioBuffer.Budget(1048576),new GleamReplyAudioBuffer.Io(){
            public void beforeWrite() throws IOException {entered.countDown();try{if(!resume.await(3,TimeUnit.SECONDS))throw new IOException("timeout");}catch(InterruptedException e){throw new IOException(e);}}
        });
        GleamReplyAudioBuffer.Write write=buffer.reserve(packet(1));ExecutorService executor=Executors.newSingleThreadExecutor();
        Future<?> writer=executor.submit(()->{try{write.append();}catch(IOException error){throw new RuntimeException(error);}});
        try{
            assertTrue(entered.await(2,TimeUnit.SECONDS));long start=System.nanoTime();buffer.clear();
            assertFalse(buffer.playing());assertFalse(buffer.current(write.generation));buffer.finish();assertTrue(buffer.drained());buffer.close();
            assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)<200);
            resume.countDown();writer.get(2,TimeUnit.SECONDS);assertNull(buffer.read());emptyEventually(dir);
        }finally{resume.countDown();executor.shutdownNow();buffer.close();}
    }
    @Test public void clearNeverWaitsForBlockedReadAndReadReturnsNoOldAudio() throws Exception {
        File dir=directory();CountDownLatch entered=new CountDownLatch(1),resume=new CountDownLatch(1);
        GleamReplyAudioBuffer buffer=new GleamReplyAudioBuffer(dir,new GleamReplyAudioBuffer.Budget(1048576),new GleamReplyAudioBuffer.Io(){
            public void beforeRead() throws IOException {entered.countDown();try{if(!resume.await(3,TimeUnit.SECONDS))throw new IOException("timeout");}catch(InterruptedException e){throw new IOException(e);}}
        });
        buffer.reserve(packet(3)).append();ExecutorService executor=Executors.newSingleThreadExecutor();Future<GleamReplyAudioBuffer.Frame> reader=executor.submit(buffer::read);
        try{assertTrue(entered.await(2,TimeUnit.SECONDS));long start=System.nanoTime();buffer.clear();assertFalse(buffer.playing());assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)<200);resume.countDown();assertNull(reader.get(2,TimeUnit.SECONDS));buffer.close();emptyEventually(dir);}
        finally{resume.countDown();executor.shutdownNow();buffer.close();}
    }
    @Test public void ciphertextTamperingFailsInsteadOfReturningCorruptAudio() throws Exception {
        File dir=directory();GleamReplyAudioBuffer buffer=new GleamReplyAudioBuffer(dir);byte[] pcm=packet(4),original=pcm.clone();buffer.reserve(pcm).append();
        File[] files=dir.listFiles();assertEquals(1,files.length);byte[] ciphertext=Files.readAllBytes(files[0].toPath());assertFalse(Arrays.equals(original,Arrays.copyOf(ciphertext,original.length)));
        try(RandomAccessFile file=new RandomAccessFile(files[0],"rw")){long offset=file.length()-1;file.seek(offset);int value=file.read();file.seek(offset);file.write(value^1);}
        try{buffer.read();fail("AEAD corruption must fail");}catch(IOException expected){}finally{buffer.close();}emptyEventually(dir);
    }
    @Test public void quotaIncludesRetiredGenerationsUntilTheirFilesAreDeleted() throws Exception {
        File dir=directory();GleamReplyAudioBuffer.Budget budget=new GleamReplyAudioBuffer.Budget(5000);GleamReplyAudioBuffer first=new GleamReplyAudioBuffer(dir,budget,new GleamReplyAudioBuffer.Io(){});
        first.reserve(packet(1)).append();assertTrue(budget.used()>4800);GleamReplyAudioBuffer second=new GleamReplyAudioBuffer(dir,budget,new GleamReplyAudioBuffer.Io(){});
        try{second.reserve(packet(2)).append();fail("global quota must fail");}catch(IOException expected){}
        first.close();second.close();emptyEventually(dir);assertEquals(0,budget.used());
    }
    @Test public void concurrentFastProducerAndSlowConsumerPreserveOrderAndSeal() throws Exception {
        File dir=directory();GleamReplyAudioBuffer buffer=new GleamReplyAudioBuffer(dir);ExecutorService executor=Executors.newSingleThreadExecutor();
        MessageDigest expected=MessageDigest.getInstance("SHA-256"),actual=MessageDigest.getInstance("SHA-256");
        for(int i=0;i<600;i++)expected.update(packet(i));
        Future<?> producer=executor.submit(()->{try{for(int i=0;i<600;i++)buffer.reserve(packet(i)).append();buffer.finish();}catch(IOException error){throw new RuntimeException(error);}});
        try{
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);int bytes=0;
            while(!buffer.drained()){
                if(System.nanoTime()>deadline)fail("consumer did not drain");
                GleamReplyAudioBuffer.Frame frame=buffer.read();
                if(frame==null){Thread.sleep(1);continue;}
                actual.update(frame.bytes);bytes+=frame.bytes.length;Thread.sleep(1);buffer.release(frame);
            }
            producer.get(2,TimeUnit.SECONDS);assertEquals(2880000,bytes);assertArrayEquals(expected.digest(),actual.digest());
            assertTrue(buffer.maxPlaintextBytes()<=GleamReplyAudioBuffer.MAX_PENDING_BYTES+65536);
        }finally{buffer.close();executor.shutdownNow();}emptyEventually(dir);
    }
    @Test public void interruptedReservationIsWipedAndLateAppendCannotPolluteNewReply() throws Exception {
        File dir=directory();GleamReplyAudioBuffer buffer=new GleamReplyAudioBuffer(dir);byte[] old=packet(1);
        GleamReplyAudioBuffer.Write write=buffer.reserve(old);buffer.clear();assertArrayEquals(new byte[old.length],old);write.append();assertNull(buffer.read());
        byte[] next=packet(2),expected=next.clone();buffer.reserve(next).append();buffer.finish();GleamReplyAudioBuffer.Frame frame=buffer.read();
        assertArrayEquals(expected,frame.bytes);buffer.release(frame);assertTrue(buffer.drained());buffer.close();emptyEventually(dir);
    }
    @Test public void clearDuringWriteFailureDoesNotContaminateNewGeneration() throws Exception {
        File dir=directory();CountDownLatch entered=new CountDownLatch(1),resume=new CountDownLatch(1);
        GleamReplyAudioBuffer buffer=new GleamReplyAudioBuffer(dir,new GleamReplyAudioBuffer.Budget(1048576),new GleamReplyAudioBuffer.Io(){
            public void beforeWrite() throws IOException {entered.countDown();try{resume.await(2,TimeUnit.SECONDS);}catch(InterruptedException error){throw new IOException(error);}throw new IOException("disk unavailable");}
        });
        GleamReplyAudioBuffer.Write write=buffer.reserve(packet(9));ExecutorService executor=Executors.newSingleThreadExecutor();
        Future<?> writer=executor.submit(()->{try{write.append();fail("write should fail");}catch(IOException expected){assertFalse(buffer.current(write.generation));}});
        try{assertTrue(entered.await(2,TimeUnit.SECONDS));buffer.clear();resume.countDown();writer.get(2,TimeUnit.SECONDS);assertFalse(buffer.playing());assertNull(buffer.read());}
        finally{resume.countDown();buffer.close();executor.shutdownNow();}emptyEventually(dir);
    }
    @Test public void startupRemovesOnlyOldEncryptedSpoolFiles() throws Exception {
        File dir=directory();File stale=new File(dir,"previous-process.gcm"),unrelated=new File(dir,"keep.txt");
        Files.write(stale.toPath(),new byte[]{1,2,3});Files.write(unrelated.toPath(),new byte[]{4});GleamReplyAudioBuffer buffer=new GleamReplyAudioBuffer(dir);
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);while(stale.exists()&&System.nanoTime()<deadline)Thread.sleep(5);
        assertFalse(stale.exists());assertTrue(unrelated.exists());buffer.close();assertTrue(unrelated.delete());emptyEventually(dir);
    }
    @Test public void oversizedPendingReservationFailsAndWipesItsPcm() throws Exception {
        File dir=directory();GleamReplyAudioBuffer buffer=new GleamReplyAudioBuffer(dir);byte[] pcm=new byte[GleamReplyAudioBuffer.MAX_PENDING_BYTES+2];Arrays.fill(pcm,(byte)7);
        try{buffer.reserve(pcm);fail("unbounded plaintext reservation");}catch(IOException expected){assertArrayEquals(new byte[pcm.length],pcm);}finally{buffer.close();}emptyEventually(dir);
    }
    @Test public void scoConverterKeepsDeltaBoundariesAndSealedTailAcrossSpool() throws Exception {
        File dir=directory();GleamReplyAudioBuffer buffer=new GleamReplyAudioBuffer(dir);GleamPcmRates rates=new GleamPcmRates();
        buffer.reserve(new byte[]{44,1,88,2}).append(); // 300, 600: retained until the next sample.
        buffer.reserve(new byte[]{(byte)132,3,100,0,44,1}).append(); // 900, 100, 300.
        buffer.finish();ByteArrayOutputStream output=new ByteArrayOutputStream();GleamReplyAudioBuffer.Frame frame;
        while((frame=buffer.read())!=null){output.write(rates.output(frame.bytes));buffer.release(frame);}
        output.write(rates.finishOutput());assertArrayEquals(new byte[]{88,2,(byte)200,0},output.toByteArray());assertTrue(buffer.drained());
        rates.output(new byte[]{(byte)231,3});buffer.clear();rates.clear();
        buffer.reserve(new byte[]{3,0,3,0,3,0}).append();frame=buffer.read();assertArrayEquals(new byte[]{3,0},rates.output(frame.bytes));buffer.release(frame);
        assertArrayEquals(new byte[0],rates.finishOutput());buffer.close();emptyEventually(dir);
    }
    @Test public void clearDoesNotReleaseQuotaWhileOldGenerationStillHasAnIoLease() throws Exception {
        File dir=directory();GleamReplyAudioBuffer.Budget budget=new GleamReplyAudioBuffer.Budget(5000);
        CountDownLatch entered=new CountDownLatch(1),resume=new CountDownLatch(1);
        GleamReplyAudioBuffer buffer=new GleamReplyAudioBuffer(dir,budget,new GleamReplyAudioBuffer.Io(){
            public void beforeRead() throws IOException {entered.countDown();try{resume.await(2,TimeUnit.SECONDS);}catch(InterruptedException error){throw new IOException(error);}}
        });
        buffer.reserve(packet(1)).append();ExecutorService executor=Executors.newSingleThreadExecutor();Future<GleamReplyAudioBuffer.Frame> reader=executor.submit(buffer::read);
        try{
            assertTrue(entered.await(2,TimeUnit.SECONDS));buffer.clear();assertEquals(4832,budget.used());
            try{buffer.reserve(packet(2)).append();fail("retired file still consumes disk");}catch(IOException expected){}
            resume.countDown();assertNull(reader.get(2,TimeUnit.SECONDS));
        }finally{resume.countDown();buffer.close();executor.shutdownNow();}emptyEventually(dir);assertEquals(0,budget.used());
    }
}

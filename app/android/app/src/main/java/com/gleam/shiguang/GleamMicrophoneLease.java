package com.gleam.shiguang;

/** Short dictation and duplex chat cannot acquire the microphone at the same time. */
final class GleamMicrophoneLease {
    private static Object owner;
    static synchronized boolean acquire(Object next) {
        if(owner!=null&&owner!=next)return false;owner=next;return true;
    }
    static synchronized void release(Object previous) { if(owner==previous)owner=null; }
    private GleamMicrophoneLease() {}
}

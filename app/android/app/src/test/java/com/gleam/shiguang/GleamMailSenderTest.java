package com.gleam.shiguang;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;
import javax.mail.*;
import javax.mail.internet.*;

public class GleamMailSenderTest {
    private final String code = "abcdefghijklmnop";
    private byte[] content() { byte[] b = new byte[80]; System.arraycopy("SKBAK1E:".getBytes(java.nio.charset.StandardCharsets.US_ASCII), 0, b, 0, 8); return b; }

    @Test public void tlsAndTimeoutsAreRequired() {
        Properties p = GleamMailSender.properties();
        assertEquals("true", p.getProperty("mail.smtps.ssl.checkserveridentity"));
        assertEquals("true", p.getProperty("mail.smtps.ssl.enable"));
        assertEquals("TLSv1.2", p.getProperty("mail.smtps.ssl.protocols"));
        assertEquals("20000", p.getProperty("mail.smtps.writetimeout"));
        assertEquals("false", p.getProperty("mail.debug"));
        assertNull(p.getProperty("mail.smtps.ssl.trust"));
    }
    @Test public void rejectsHeaderInjectionAndPlaintext() {
        for (String recipient : new String[]{"a@qq.com,b@qq.com", "a@qq.com\r\nBcc:x@qq.com"}) {
            try { GleamMailSender.validate("demo@qq.com", recipient, code); fail(); } catch (IllegalArgumentException expected) {}
        }
        try { GleamMailSender.validateAttachment("../x.skbak", content()); fail(); } catch (IllegalArgumentException expected) {}
        try { GleamMailSender.validateAttachment("x.skbak", new byte[80]); fail(); } catch (IllegalArgumentException expected) {}
        try { GleamMailSender.validateAttachment("x.skbak", new byte[GleamMailSender.MAX_BYTES + 1]); fail(); } catch (IllegalArgumentException expected) {}
    }
    @Test public void mimeAttachmentRoundTripsWithoutCredentials() throws Exception {
        MimeMessage m = GleamMailSender.message(Session.getInstance(GleamMailSender.properties()), "demo@qq.com", "recipient@example.test", "虚构备份.skbak", content());
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(); m.writeTo(out);
        assertFalse(out.toString("UTF-8").contains(code));
        MimeMessage parsed = new MimeMessage(Session.getInstance(new Properties()), new java.io.ByteArrayInputStream(out.toByteArray()));
        assertEquals(1, parsed.getAllRecipients().length);
        MimeMultipart parts = (MimeMultipart) parsed.getContent();
        assertEquals(2, parts.getCount());
        assertEquals("虚构备份.skbak", MimeUtility.decodeText(parts.getBodyPart(1).getFileName()));
        assertArrayEquals(content(), parts.getBodyPart(1).getInputStream().readAllBytes());
    }
    @Test public void connectionTestSendsNoMessageAndCloseCannotMaskAcceptance() throws Exception {
        FakeTransport fake = new FakeTransport();
        GleamMailSender.execute("demo@qq.com", "recipient@example.test", code, null, null, session -> fake);
        assertEquals(0, fake.sent);
        GleamMailSender.execute("demo@qq.com", "recipient@example.test", code, "demo.skbak", content(), session -> fake);
        assertEquals(1, fake.sent);
        assertEquals("smtp.qq.com", fake.host); assertEquals(465, fake.port);
    }
    @Test public void durableLedgerPreventsDuplicatesAndUncertainResends() throws Exception {
        Map<String, String> values = new HashMap<>();
        GleamMailLedger.Store store = new GleamMailLedger.Store() {
            public String get(String key) { return values.get(key); }
            public void put(String key, String value) { values.put(key, value); }
        };
        int[] sent = {0};
        new GleamMailLedger(store).send("request-001", "hash", () -> sent[0]++);
        new GleamMailLedger(store).send("request-001", "hash", () -> sent[0]++);
        assertEquals(1, sent[0]);
        try { new GleamMailLedger(store).send("request-002", "hash", () -> { throw new java.io.IOException(); }); fail(); } catch (java.io.IOException expected) {}
        try { new GleamMailLedger(store).send("request-002", "hash", () -> sent[0]++); fail(); } catch (IllegalStateException expected) {}
        try { new GleamMailLedger(store).send("request-001", "changed", () -> sent[0]++); fail(); } catch (IllegalStateException expected) {}
        assertEquals(1, sent[0]);
    }
    static class FakeTransport extends Transport {
        int sent, port; String host;
        FakeTransport() { super(Session.getInstance(new Properties()), null); }
        @Override public void connect(String host, int port, String username, String password) { this.host = host; this.port = port; }
        @Override public void sendMessage(Message message, Address[] recipients) { sent++; }
        @Override public void close() throws MessagingException { throw new MessagingException("synthetic close failure"); }
    }
}

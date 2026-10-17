package com.gleam.shiguang;

import java.util.Date;
import java.util.Properties;
import java.nio.charset.StandardCharsets;
import javax.activation.DataHandler;
import javax.mail.Message;
import javax.mail.MessagingException;
import javax.mail.Session;
import javax.mail.Transport;
import javax.mail.internet.InternetAddress;
import javax.mail.internet.MimeBodyPart;
import javax.mail.internet.MimeMessage;
import javax.mail.internet.MimeMultipart;
import javax.mail.internet.MimeUtility;
import javax.mail.util.ByteArrayDataSource;

/** Fixed QQ SMTPS destination. No redirects, arbitrary servers, plaintext or debug logging. */
final class GleamMailSender {
    static final int MAX_BYTES = 10 * 1024 * 1024;
    interface TransportFactory { Transport create(Session session) throws MessagingException; }

    static Properties properties() {
        Properties p = new Properties();
        p.setProperty("mail.transport.protocol", "smtps");
        p.setProperty("mail.smtps.auth", "true");
        p.setProperty("mail.smtps.ssl.enable", "true");
        p.setProperty("mail.smtps.ssl.checkserveridentity", "true");
        p.setProperty("mail.smtps.ssl.protocols", "TLSv1.2");
        p.setProperty("mail.smtps.connectiontimeout", "15000");
        p.setProperty("mail.smtps.timeout", "20000");
        p.setProperty("mail.smtps.writetimeout", "20000");
        p.setProperty("mail.smtps.quitwait", "false");
        p.setProperty("mail.debug", "false");
        return p;
    }

    static boolean validAddress(String value) {
        return value != null && value.length() <= 254 && value.matches("[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+");
    }

    static void validate(String username, String recipient, String authCode) {
        if (!validAddress(username) || !username.toLowerCase(java.util.Locale.ROOT).matches(".*@(qq|foxmail)\\.com")
            || !validAddress(recipient) || authCode == null || !authCode.matches("[A-Za-z]{16}")) {
            throw new IllegalArgumentException("INVALID");
        }
    }

    static void validateAttachment(String name, byte[] content) {
        if (name == null || !name.matches("[\\p{L}\\p{N}_.-]{1,100}\\.skbak") || content == null || content.length < 52 || content.length > MAX_BYTES
            || !"SKBAK1E:".equals(new String(content, 0, 8, StandardCharsets.US_ASCII))) throw new IllegalArgumentException("INVALID");
    }

    static MimeMessage message(Session session, String username, String recipient, String name, byte[] content) throws Exception {
        validateAttachment(name, content);
        MimeMessage message = new MimeMessage(session);
        message.setFrom(new InternetAddress(username));
        message.setRecipient(Message.RecipientType.TO, new InternetAddress(recipient));
        message.setSubject("拾光加密备份", "UTF-8");
        message.setSentDate(new Date());
        MimeBodyPart text = new MimeBodyPart();
        text.setText("附件为拾光完整加密备份。下载后在拾光选择备份文件恢复，口令由你自行保管，本邮件不含口令。", "UTF-8");
        MimeBodyPart file = new MimeBodyPart();
        file.setDataHandler(new DataHandler(new ByteArrayDataSource(content, "application/octet-stream")));
        file.setFileName(MimeUtility.encodeText(name, "UTF-8", "B"));
        file.setDisposition(javax.mail.Part.ATTACHMENT);
        MimeMultipart parts = new MimeMultipart(); parts.addBodyPart(text); parts.addBodyPart(file);
        message.setContent(parts); message.saveChanges();
        return message;
    }

    static void execute(String username, String recipient, String authCode, String name, byte[] content) throws Exception {
        execute(username, recipient, authCode, name, content, session -> session.getTransport("smtps"));
    }

    static void execute(String username, String recipient, String authCode, String name, byte[] content, TransportFactory factory) throws Exception {
        validate(username, recipient, authCode);
        Session session = Session.getInstance(properties());
        session.setDebug(false);
        MimeMessage message = content == null ? null : message(session, username, recipient, name, content);
        Transport transport = factory.create(session);
        try {
            transport.connect("smtp.qq.com", 465, username, authCode);
            if (message != null) transport.sendMessage(message, message.getAllRecipients());
        } finally {
            try { transport.close(); } catch (MessagingException ignored) { /* Do not turn accepted DATA into a duplicate retry. */ }
        }
    }
}

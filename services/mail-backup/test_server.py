"""Offline relay tests: only synthetic attachments and mocked SMTP."""
import base64
import http.client
import json
import os
import smtplib
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from http.server import ThreadingHTTPServer
from server import Config, Relay, RequestError, handler_for, qq_transport, MAX_BYTES, MAX_BODY


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cfg = Config('fictional_' * 4, 'fictional@qq.com', 'fictional-authorization',
                          'fictional@example.test', ('https://app.example.test',), self.tmp.name + '/requests.sqlite3')
        self.smtp = Mock()
        self.relay = Relay(self.cfg, self.smtp)
        self.payload = {
            'recipient': self.cfg.recipient, 'requestId': 'fictional-request-001',
            'fileName': '拾光备份_20261017_1200.skbak',
            'contentBase64': base64.b64encode(b'SKBAK1E:' + b'x' * 64).decode(),
        }

    def error(self, data, status, path='/v1/backup'):
        with self.assertRaises(RequestError) as cm:
            self.relay.handle(path, data)
        self.assertEqual(cm.exception.status, status)

    def test_connection_does_not_send_attachment(self):
        self.assertEqual(self.relay.handle('/v1/test', {'recipient': self.cfg.recipient})['status'], 'ready')
        self.smtp.assert_called_once_with(self.cfg)

    def test_encrypted_attachment_and_recipient_round_trip(self):
        self.assertEqual(self.relay.handle('/v1/backup', self.payload)['status'], 'accepted')
        cfg, message = self.smtp.call_args.args
        self.assertEqual(message['To'], cfg.recipient)
        self.assertEqual(message['From'], cfg.username)
        attachment, = message.iter_attachments()
        self.assertEqual(attachment.get_filename(), self.payload['fileName'])
        self.assertEqual(attachment.get_payload(decode=True), base64.b64decode(self.payload['contentBase64']))
        self.assertNotIn(cfg.password, message.as_string())
        self.assertNotIn(cfg.token, message.as_string())

    def test_idempotency_survives_process_restart(self):
        self.relay.handle('/v1/backup', self.payload)
        restarted = Relay(self.cfg, self.smtp)
        self.assertEqual(restarted.handle('/v1/backup', self.payload)['status'], 'accepted')
        self.smtp.assert_called_once()
        self.error({**self.payload, 'fileName': 'different.skbak'}, 409)

    def test_uncertain_smtp_delivery_is_not_retried(self):
        self.smtp.side_effect = TimeoutError('private-smtp-detail')
        self.error(self.payload, 502)
        self.error(self.payload, 409)
        self.smtp.assert_called_once()

    def test_only_configured_recipient_and_safe_filename(self):
        self.error({**self.payload, 'recipient': 'other@example.test'}, 403)
        for name in ('../backup.skbak', 'x\r\nBcc:other.skbak', 'backup.exe'):
            self.error({**self.payload, 'fileName': name}, 400)
        self.smtp.assert_not_called()

    def test_plaintext_invalid_and_large_payloads_rejected(self):
        self.error({**self.payload, 'contentBase64': base64.b64encode(b'PK' + b'x' * 64).decode()}, 400)
        self.error({**self.payload, 'contentBase64': 'not-base64'}, 400)
        self.error({**self.payload, 'contentBase64': base64.b64encode(b'x' * (MAX_BYTES + 1)).decode()}, 413)
        self.error({**self.payload, 'requestId': '../../secret'}, 400)
        self.smtp.assert_not_called()

    def test_rate_limit_and_busy(self):
        for _ in range(6):
            self.relay.handle('/v1/test', {'recipient': self.cfg.recipient})
        self.error({'recipient': self.cfg.recipient}, 429, '/v1/test')
        with self.relay.lock:
            self.error(self.payload, 429)

    def test_qq_smtps_verifies_tls_and_sends_to_single_recipient(self):
        smtp = Mock()
        smtp.send_message.return_value = {}
        with patch('server.smtplib.SMTP_SSL', return_value=smtp) as factory:
            qq_transport(self.cfg, 'synthetic-message')
        args, kwargs = factory.call_args
        self.assertEqual(args, ('smtp.qq.com', 465))
        self.assertTrue(kwargs['context'].check_hostname)
        self.assertEqual(kwargs['context'].verify_mode, 2)
        smtp.login.assert_called_once_with(self.cfg.username, self.cfg.password)
        smtp.send_message.assert_called_once_with('synthetic-message', from_addr=self.cfg.username, to_addrs=[self.cfg.recipient])
        smtp.close.assert_called_once()

    def test_config_validation(self):
        env = {'GLEAM_MAIL_TOKEN': self.cfg.token, 'GLEAM_MAIL_SMTP_USER': self.cfg.username,
               'GLEAM_MAIL_SMTP_AUTH_CODE': self.cfg.password, 'GLEAM_MAIL_TO': self.cfg.recipient,
               'GLEAM_MAIL_ALLOWED_ORIGINS': 'https://app.example.test,http://localhost:5173'}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(Config.from_env().recipient, self.cfg.recipient)
        for key, value in [('GLEAM_MAIL_TOKEN', 'short'), ('GLEAM_MAIL_TO', 'a@b.test,c@d.test'),
                           ('GLEAM_MAIL_ALLOWED_ORIGINS', '*'), ('GLEAM_MAIL_SMTP_AUTH_CODE', '')]:
            with patch.dict(os.environ, {**env, key: value}, clear=True), self.assertRaises(ValueError):
                Config.from_env()


class HttpTests(unittest.TestCase):
    def setUp(self):
        RelayTests.setUp(self)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(self.relay))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def post(self, payload=None, headers=None, method='POST', path='/v1/backup'):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            values = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.cfg.token,
                      'Origin': self.cfg.origins[0], **(headers or {})}
            conn.request(method, path, body=json.dumps(payload if payload is not None else self.payload), headers=values)
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read().decode()
        finally:
            conn.close()

    def test_http_auth_cors_and_body(self):
        status, headers, body = self.post()
        self.assertEqual(status, 200)
        self.assertEqual(headers['Access-Control-Allow-Origin'], self.cfg.origins[0])
        self.assertEqual(json.loads(body)['status'], 'accepted')
        for headers, status in [({'Authorization': 'Bearer wrong'}, 401), ({'Origin': 'https://evil.example'}, 403),
                                ({'Content-Length': str(MAX_BODY + 1)}, 413), ({'Content-Type': 'text/plain'}, 400)]:
            self.assertEqual(self.post(headers=headers)[0], status)
        self.assertEqual(self.post(path='/unknown')[0], 404)
        self.assertEqual(self.post(method='OPTIONS')[0], 200)

    def test_http_error_has_no_secrets(self):
        self.smtp.side_effect = smtplib.SMTPAuthenticationError(535, self.cfg.password)
        status, _, body = self.post()
        self.assertEqual(status, 502)
        self.assertNotIn(self.cfg.password, body)
        self.assertNotIn(self.cfg.username, body)


if __name__ == '__main__':
    unittest.main()

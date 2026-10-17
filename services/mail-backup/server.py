"""Private QQ SMTP relay. Run behind HTTPS; only encrypted .skbak attachments.

Python 3.11+, standard library only. Never logs credentials, bodies or addresses.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import smtplib
import sqlite3
import ssl
import threading
import time
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

MAX_BYTES = 10 * 1024 * 1024
MAX_BODY = ((MAX_BYTES + 2) // 3) * 4 + 4096
EMAIL = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$")


@dataclass(frozen=True)
class Config:
    token: str
    username: str
    password: str
    recipient: str
    origins: tuple[str, ...]
    database: str

    @classmethod
    def from_env(cls):
        cfg = cls(
            os.environ.get('GLEAM_MAIL_TOKEN', ''),
            os.environ.get('GLEAM_MAIL_SMTP_USER', ''),
            os.environ.get('GLEAM_MAIL_SMTP_AUTH_CODE', ''),
            os.environ.get('GLEAM_MAIL_TO', ''),
            tuple(filter(None, (s.strip() for s in os.environ.get('GLEAM_MAIL_ALLOWED_ORIGINS', '').split(',')))),
            os.environ.get('GLEAM_MAIL_STATE', './state/requests.sqlite3'),
        )
        if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', cfg.token):
            raise ValueError('GLEAM_MAIL_TOKEN must contain 32-256 URL-safe characters')
        if not EMAIL.fullmatch(cfg.username) or not cfg.username.lower().endswith(('@qq.com', '@foxmail.com')):
            raise ValueError('GLEAM_MAIL_SMTP_USER must be a QQ or Foxmail address')
        if not cfg.password or any(c in cfg.password for c in '\r\n'):
            raise ValueError('GLEAM_MAIL_SMTP_AUTH_CODE is required')
        if len(cfg.recipient) > 254 or not EMAIL.fullmatch(cfg.recipient):
            raise ValueError('GLEAM_MAIL_TO must be one email address')
        for origin in cfg.origins:
            parsed = urlsplit(origin)
            if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
                raise ValueError('GLEAM_MAIL_ALLOWED_ORIGINS must contain exact origins, without paths')
        return cfg


class RequestError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def qq_transport(config, message=None):
    # SMTP_SSL verifies certificate chain and hostname. No plaintext fallback.
    smtp = smtplib.SMTP_SSL('smtp.qq.com', 465, timeout=20, context=ssl.create_default_context())
    try:
        smtp.login(config.username, config.password)
        if message is not None:
            refused = smtp.send_message(message, from_addr=config.username, to_addrs=[config.recipient])
            if refused:
                raise smtplib.SMTPRecipientsRefused(refused)
    finally:
        # Close without an additional QUIT round trip that could mask accepted DATA.
        smtp.close()


class Relay:
    def __init__(self, config, transport=qq_transport):
        self.config, self.transport = config, transport
        self.lock = threading.Lock()
        self.attempts = []
        Path(config.database).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with sqlite3.connect(config.database) as db:
            db.execute('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL)')

    def handle(self, path, data):
        if not isinstance(data, dict) or data.get('recipient') != self.config.recipient:
            raise RequestError(403, 'recipient_not_allowed')
        if not self.lock.acquire(blocking=False):
            raise RequestError(429, 'busy')
        try:
            if path == '/v1/backup':
                return self.send(data)
            if path != '/v1/test':
                raise RequestError(404, 'not_found')
            self.rate_limit()
            try:
                self.transport(self.config)
            except Exception:
                raise RequestError(502, 'smtp_unavailable') from None
            return {'status': 'ready', 'recipient': self.config.recipient}
        finally:
            self.lock.release()

    def rate_limit(self):
        now = time.monotonic()
        self.attempts = [t for t in self.attempts if now - t < 60]
        if len(self.attempts) >= 6:
            raise RequestError(429, 'rate_limited')
        self.attempts.append(now)

    def send(self, data):
        ident, name, encoded = data.get('requestId'), data.get('fileName'), data.get('contentBase64')
        if not isinstance(ident, str) or not re.fullmatch(r'[A-Za-z0-9-]{8,80}', ident):
            raise RequestError(400, 'invalid_request_id')
        if not isinstance(name, str) or not re.fullmatch(r'[\w.-]{1,100}\.skbak', name):
            raise RequestError(400, 'invalid_filename')
        if not isinstance(encoded, str) or len(encoded) > ((MAX_BYTES + 2) // 3) * 4:
            raise RequestError(413, 'too_large')
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            raise RequestError(400, 'invalid_base64') from None
        if len(content) > MAX_BYTES:
            raise RequestError(413, 'too_large')
        if len(content) < 52 or not content.startswith(b'SKBAK1E:'):
            raise RequestError(400, 'encrypted_backup_required')
        digest = hashlib.sha256(name.encode() + b'\0' + self.config.recipient.encode() + b'\0' + content).hexdigest()
        with sqlite3.connect(self.config.database) as db:
            row = db.execute('SELECT digest, status FROM requests WHERE id=?', (ident,)).fetchone()
            if row:
                if row == (digest, 'accepted'):
                    return {'status': 'accepted', 'requestId': ident}
                raise RequestError(409, 'delivery_uncertain')
            self.rate_limit()
            # Persist before SMTP: a crash or lost HTTP response cannot cause an automatic resend.
            db.execute('INSERT INTO requests VALUES (?, ?, ?, ?)', (ident, digest, 'pending', time.time()))
        message = EmailMessage()
        message['From'], message['To'] = self.config.username, self.config.recipient
        message['Subject'] = '拾光加密备份'
        message['Date'], message['Message-ID'] = formatdate(localtime=False), make_msgid()
        message.set_content('附件为拾光完整加密备份。下载 .skbak 后，在拾光「从备份文件恢复」中导入。恢复口令由你自行保管，本邮件不含口令。')
        message.add_attachment(content, maintype='application', subtype='octet-stream', filename=name)
        try:
            self.transport(self.config, message)
        except Exception:
            # Retain pending: SMTP may have accepted DATA before the connection failed.
            raise RequestError(502, 'delivery_uncertain') from None
        with sqlite3.connect(self.config.database) as db:
            db.execute('UPDATE requests SET status=? WHERE id=?', ('accepted', ident))
        return {'status': 'accepted', 'requestId': ident}


def handler_for(relay):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'GleamMail/1'

        def setup(self):
            super().setup()
            self.connection.settimeout(20)

        def log_message(self, *_args):
            pass

        def reply(self, status, data):
            raw = json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            origin = self.headers.get('Origin')
            if origin in relay.config.origins:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
                self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.end_headers()
            self.wfile.write(raw)

        def origin_allowed(self):
            origin = self.headers.get('Origin')
            return origin is None or origin in relay.config.origins

        def do_OPTIONS(self):
            self.reply(200 if self.origin_allowed() else 403, {})

        def do_POST(self):
            try:
                if self.path not in ('/v1/test', '/v1/backup'):
                    raise RequestError(404, 'not_found')
                if not self.origin_allowed():
                    raise RequestError(403, 'origin_not_allowed')
                supplied = self.headers.get('Authorization', '').encode()
                expected = ('Bearer ' + relay.config.token).encode()
                if not hmac.compare_digest(supplied, expected):
                    raise RequestError(401, 'unauthorized')
                if self.headers.get('Transfer-Encoding') or self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
                    raise RequestError(400, 'json_required')
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                except ValueError:
                    raise RequestError(400, 'invalid_length') from None
                limit = 4096 if self.path == '/v1/test' else MAX_BODY
                if length < 1 or length > limit:
                    raise RequestError(413, 'too_large')
                body = self.rfile.read(length)
                if len(body) != length:
                    raise RequestError(400, 'incomplete_body')
                try:
                    data = json.loads(body)
                except (ValueError, UnicodeError):
                    raise RequestError(400, 'invalid_json') from None
                self.reply(200, relay.handle(self.path, data))
            except RequestError as error:
                self.reply(error.status, {'error': error.code})
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                self.close_connection = True
            except Exception:
                self.reply(500, {'error': 'internal_error'})

    return Handler


def main():
    os.umask(0o077)
    try:
        cfg = Config.from_env()
        relay = Relay(cfg)
        port = int(os.environ.get('GLEAM_MAIL_PORT', '8788'))
    except (ValueError, OSError, sqlite3.Error) as error:
        # Config errors contain names only. OS/database errors may contain paths.
        raise SystemExit(str(error) if isinstance(error, ValueError) else 'Mail service state initialization failed') from None
    server = ThreadingHTTPServer(('127.0.0.1', port), handler_for(relay))
    print('Gleam mail relay listening on loopback; HTTPS reverse proxy required', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()

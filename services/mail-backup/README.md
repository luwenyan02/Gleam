# QQ 邮箱备份发送服务

Android 和网页版共用本服务：拾光生成口令加密的完整 `.skbak`，通过 HTTPS 提交，由服务使用 QQ 邮箱 `smtp.qq.com:465`（SSL）发送。QQ 授权码仅存服务端，应用中只填写服务地址、访问令牌和收件邮箱。不需要新增拾光账户。

服务只向配置的一个邮箱发送；测试连接只登录 SMTP，不发信。单份加密文件最大 10 MiB（界面标记 10 MB），超过限制改用 WebDAV/S3/本地备份。QQ 邮箱自身的附件、频率和反垃圾限制仍适用。

## 部署条件

- 一台你控制的长期运行 Linux 服务器，Python 3.11+（只用标准库，无第三方依赖），能访问 QQ SMTP 的 TCP 465。
- 指向该服务器的域名、有效 HTTPS 证书和反向代理（以下示例使用 Caddy）。开放 HTTPS 端口；服务内部只监听 `127.0.0.1:8788`，不要直接暴露内部端口。
- QQ 邮箱设置中开启 SMTP，并生成邮箱授权码。这里使用授权码，不是 QQ 登录密码。
- Codex 开发环境用于测试代码，不充当正式邮件服务；其任务磁盘和进程不是长期托管承诺。

## 服务端配置项

| 名称 | 用途 |
| --- | --- |
| `GLEAM_MAIL_SMTP_USER` | 发件 QQ/Foxmail 邮箱地址 |
| `GLEAM_MAIL_SMTP_AUTH_CODE` | QQ 邮箱 SMTP 授权码 |
| `GLEAM_MAIL_TO` | 唯一允许的收件邮箱，可以与发件邮箱相同 |
| `GLEAM_MAIL_TOKEN` | 32–256 位随机访问令牌，只用字母、数字、`_`、`-` |
| `GLEAM_MAIL_ALLOWED_ORIGINS` | 允许的网页来源，逗号分隔，精确包含协议和端口，不带尾部 `/` |
| `GLEAM_MAIL_PORT` | 内部监听端口，默认 `8788` |
| `GLEAM_MAIL_STATE` | 请求去重 SQLite 文件，必须使用持久目录 |

用 `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'` 在自己的终端生成令牌。实际值写入服务器上的 `/etc/gleam-mail.env`，权限设为 `600`；不要写进仓库或聊天。

`GLEAM_MAIL_ALLOWED_ORIGINS` 包含实际网页地址，例如 `http://localhost:5173,https://gleam.example.com,https://localhost`。Android 使用原生 HTTP 通道，可能不发送 Origin；仍必须有正确令牌。浏览器 Origin 不匹配时会拒绝，不能改成 `*`。收件邮箱在客户端和服务端必须一致。

## Linux + systemd 示例

以下由服务器管理员执行；如路径或用户已存在，应沿用并检查，不覆盖现有配置。

1. 创建专用用户 `gleam-mail`，将本目录的 `server.py` 放到 `/opt/gleam-mail/server.py`。
2. 参考 `config.example` 创建 `/etc/gleam-mail.env` 并填值。systemd 环境文件每行 `名称=值`，无需 `export`。使用 `GLEAM_MAIL_STATE=/var/lib/gleam-mail/requests.sqlite3`。
3. 将 `gleam-mail.service` 安装到 `/etc/systemd/system/`，然后执行：

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now gleam-mail
   sudo systemctl status gleam-mail
   ```

4. 把 `Caddyfile.example` 中的站点块合入已有 Caddy 配置，替换域名；先用 `caddy validate --config /etc/caddy/Caddyfile` 验证，再按现有部署方式重载。不要覆盖其他站点。反向代理不得记录 Authorization、请求体或备份内容。
5. 拾光「备份与恢复 → 邮箱备份」填写 `https://你的域名`、同一访问令牌、同一收件邮箱，点击「保存并测试」。成功只说明服务可连接并登录 QQ SMTP。
6. 用虚构账本点击「发送备份」，设置至少 8 位备份口令，确认收件人后点击「生成并发送」。核对收到的附件能通过现有恢复流程读取，再用于自己的账本。

源码或环境配置更新后重启该服务。只运行一个服务实例并保留状态目录。状态库只保存请求 ID、文件摘要、状态、时间，不落地附件、口令或授权码；不要为了重试而删除它。

## 发送状态与恢复

- 返回 `accepted` 表示 QQ SMTP 接收了邮件，不保证已经投递到收件箱。请同时检查垃圾邮件和退信。
- 客户端失去响应后，“重试同一备份”复用请求 ID；已接收的请求不会再次发信。SMTP 中途断线或进程崩溃留下的不确定请求返回 409，也不会自动补发。先查收件箱，确认未收到后关闭发送抽屉再重新发起。
- 客户端不会自动重试或定时发邮件。服务每分钟最多允许 6 次新的 SMTP 操作，重复已接收请求只返回原结果。
- 完整备份必须加密；口令不上传至服务、不存储、不写邮件。服务会接触加密附件并传给 QQ 邮箱。遗忘口令无法恢复。
- 收到邮件后下载 `.skbak`，在拾光「从备份文件恢复」中选择文件、填写口令、核对内容并确认。邮件入口不读取邮箱，也不提供邮箱文件列表或删除功能。
- Web 访问令牌只保留当前标签页会话；Android 沿用系统 Keystore。QQ 授权码和服务访问令牌均不进入备份。

## 离线验证

仓库根目录运行：

```sh
python3 -m unittest discover -s services/mail-backup -p 'test_*.py' -v
python3 scripts/cloud-env.py run npm run test:unit -- tests/email-backup.test.ts
```

测试使用虚构数据及模拟 SMTP，覆盖鉴权、来源限制、收件人限制、附件字节、加密限制、超限、超时、重复请求和重启去重。真实 QQ 收件、域名证书、反向代理和 Android 真机需部署后单独验收。

/**
 * 拾光 · 应用锁（features/settings/lock，PRD 4.19）
 * - PIN：SHA-256(盐 + PIN) 十六进制存 settings（'security.pin'），明文不落库；
 * - WebAuthn：平台认证器（Touch ID / 生物识别），凭据 id 存 'security.webauthn'，
 *   不可用时降级隐藏；解锁走 navigator.credentials.get + userVerification。
 * enforceAppLock() 在 main.ts 挂载外壳前调用：未开启锁直接放行，
 * 开启则显示全屏遮罩，PIN 或生物识别通过后 resolve。
 */
import { iconHtml } from '../../assets/icons';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';

/* ── 哈希与编码 ── */

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/* ── PIN 管理（设置页调用） ── */

/** 设置 / 修改 PIN（≥4 位数字由界面校验，这里只负责哈希落库） */
export async function setPin(pin: string): Promise<void> {
  const salt = randomSalt();
  const hash = await sha256Hex(salt + pin);
  await setSetting('security.pin', { hash, salt });
}

/** 校验 PIN */
export async function verifyPin(pin: string): Promise<boolean> {
  const saved = await getSetting('security.pin');
  if (!saved) return true;
  return (await sha256Hex(saved.salt + pin)) === saved.hash;
}

/** 关闭应用锁（同时清掉生物识别凭据） */
export async function clearPin(): Promise<void> {
  await setSetting('security.pin', null);
  await setSetting('security.webauthn', null);
}

/* ── WebAuthn 平台认证器 ── */

/** 平台认证器是否可用（不可用时设置页隐藏该项） */
export async function biometricAvailable(): Promise<boolean> {
  try {
    if (!window.PublicKeyCredential) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** 注册平台认证器凭据（启用 Touch ID / 生物识别） */
export async function enrollBiometric(): Promise<void> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: '拾光', id: location.hostname },
      user: {
        id: new TextEncoder().encode('gleam-local-user'),
        name: '拾光用户',
        displayName: '拾光用户',
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
      timeout: 60000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('未能创建生物识别凭据');
  await setSetting('security.webauthn', { credId: b64url(new Uint8Array(cred.rawId)) });
}

/** 用平台认证器解锁（用户取消/失败返回 false） */
export async function verifyBiometric(): Promise<boolean> {
  const saved = await getSetting('security.webauthn');
  if (!saved) return false;
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: fromB64url(saved.credId) as BufferSource }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    return assertion != null;
  } catch {
    return false;
  }
}

/* ── 启动锁屏 ── */

/**
 * 启动时强制解锁：未开启 PIN 直接返回；否则渲染全屏遮罩，
 * PIN 校验或生物识别通过后移除遮罩并 resolve。
 */
export async function enforceAppLock(): Promise<void> {
  const pin = await getSetting('security.pin');
  if (!pin) return;
  const hasBio = (await getSetting('security.webauthn')) != null && (await biometricAvailable());

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'lock-overlay';
    overlay.innerHTML = `
      <span class="lk-ic">${iconHtml('ic-lock', 26)}</span>
      <h1>拾光已锁定</h1>
      <p class="lk-sub">输入 PIN 码解锁</p>
      <input type="password" inputmode="numeric" autocomplete="off" maxlength="12" aria-label="PIN 码">
      <p class="lk-err"></p>
      <button class="btn primary" data-act="unlock">解锁</button>
      ${hasBio ? `<button class="lk-bio" data-act="bio">使用 Touch ID / 生物识别</button>` : ''}`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector<HTMLInputElement>('input')!;
    const err = overlay.querySelector<HTMLElement>('.lk-err')!;
    const done = () => { overlay.remove(); resolve(); };

    const tryPin = async () => {
      if (!input.value) return;
      if (await verifyPin(input.value)) done();
      else {
        err.textContent = 'PIN 码不正确';
        input.value = '';
      }
    };
    overlay.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'unlock') void tryPin();
      else if (act === 'bio') {
        void verifyBiometric().then((ok) => {
          if (ok) done();
          else err.textContent = '生物识别未通过，请输入 PIN';
        });
      }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void tryPin(); });
    input.focus();
    // 有生物识别时启动即尝试一次
    if (hasBio) {
      void verifyBiometric().then((ok) => { if (ok) done(); });
    }
  });
}

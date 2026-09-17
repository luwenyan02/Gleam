import { esc } from '../../core/esc';
import type { LifeDraft, LifeNote } from '../../core/types';
import { getLifeNote } from '../../core/repo/lifeRepo';
import { getLifeDraft, migrateLifeDraft, putLifeDraft, saveLifeDraft } from '../../core/repo/lifeDraftRepo';
import { continueLifeChat, generateLifeSummary, getLifeAiDestination } from '../../core/repo/lifeAiRepo';
import { on } from '../../core/store';
import { getSetting } from '../../core/repo/settingsRepo';
import { prepareReceipt } from '../entry/receiptEditor';
import { confirmLifeAi } from './lifeAiConsent';
import { registerSubpage, openSubpage, closeSubpage } from '../shell/router';
import { closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { openLifeSummarySheet } from './lifeSummarySheet';
import './lifeAi.css';

type Destination = { baseUrl: string; model: string };
interface Launch { draft: LifeDraft; existing?: LifeNote; }
let pendingLaunch: Launch | undefined;

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('照片读取失败'));
    reader.readAsDataURL(blob);
  });
}

function newDraft(key: string, existing?: LifeNote): LifeDraft {
  return {
    key,
    noteId: existing?.id,
    sourceUpdatedAt: existing?.updatedAt,
    title: '', body: '', occurredAt: existing?.occurredAt ?? Date.now(),
    existingPhotoRefs: [...(existing?.photoRefs ?? [])], photos: [],
    messages: structuredClone(existing?.conversation ?? []),
    aiExcluded: existing?.aiExcluded ?? false,
  };
}

/** 注册独立全屏聊天子页。 */
export function initLifeChat(): void {
  registerSubpage('sp-life-chat', { title: '和拾光聊聊', render(el) {
    const launch = pendingLaunch;
    pendingLaunch = undefined;
    if (!launch) { el.innerHTML = '<p class="sub">对话暂时没有打开。</p>'; return; }
    renderChat(el, launch);
  } });
}

/** 新会话使用 chat:new；已有记录的会话始终以完整 conversation 为基线。 */
export async function openLifeChat(options: { noteId?: number } = {}): Promise<void> {
  try {
    const existing = options.noteId == null ? undefined : await getLifeNote(options.noteId);
    if (options.noteId != null && (!existing || existing.deletedAt)) throw new Error('这条记录已不在当前生活时间流中');
    const key = existing ? `chat:note:${existing.id}` : 'chat:new';
    const stored = await getLifeDraft(key);
    const draft = stored ? migrateLifeDraft(stored) : newDraft(key, existing);
    if (existing && !draft.messages.length) draft.messages = structuredClone(existing.conversation ?? []);
    pendingLaunch = { draft, existing };
    openSubpage('sp-life-chat');
  } catch (error) { showToast(error instanceof Error ? error.message : '对话暂时打不开'); }
}

function renderChat(host: HTMLElement, launch: Launch): void {
  const { draft, existing } = launch;
  let disposed = false;
  let sending = false;
  let readyToSummarize = false;
  let failedMessageIndex: number | undefined;
  let controller: AbortController | undefined;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let authorisedDestination: Destination | undefined;
  let authorisedPhotoSignature: string | undefined;
  const persist = async (): Promise<void> => { await putLifeDraft(structuredClone(draft)); };
  const persistQuiet = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { void persist().catch(() => showToast('草稿暂存在当前页面，请勿刷新；可重新打开重试保存')); }, 220);
  };
  const observer = new MutationObserver(() => { if (!host.isConnected && !disposed) dispose(); });
  observer.observe(document.body, { childList: true, subtree: true });
  const off = on('settings-changed', () => { void getSetting('life.aiEnabled').then(enabled => { if (!enabled) controller?.abort(); }); });

  host.classList.add('life-chat-page');
  host.innerHTML = `<div class="life-chat" aria-label="和拾光聊聊">
    <div id="life-chat-messages" class="life-chat-messages" aria-live="polite"></div>
    <p id="life-chat-status" class="life-chat-status" role="status"></p>
    <div class="life-chat-input-wrap">
      <div class="life-chat-photos" id="life-chat-photos"></div>
      <input id="lchat-file" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden>
      <button class="icon-btn" data-life-chat-photo aria-label="添加照片">＋</button>
      <label class="sr-only" for="life-chat-input">和拾光说说</label><textarea id="life-chat-input" maxlength="2000" placeholder="说说今天想留下的小事…"></textarea>
      <button class="btn primary life-chat-send" data-life-chat-send>发送</button><button class="btn ghost life-chat-stop" data-life-chat-stop hidden>停止</button>
    </div>
  </div>`;
  const messagesEl = host.querySelector<HTMLElement>('#life-chat-messages')!;
  const input = host.querySelector<HTMLTextAreaElement>('#life-chat-input')!;
  const status = (text: string) => { if (!disposed) host.querySelector<HTMLElement>('#life-chat-status')!.textContent = text; };

  function dispose(): void {
    disposed = true;
    clearTimeout(persistTimer);
    controller?.abort();
    observer.disconnect();
    off();
    void persist().catch(() => {});
  }
  function render(): void {
    const welcome = !draft.messages.length ? '<article class="life-chat-bubble assistant"><span>拾光</span>今天有什么小事，想让我陪你留一下？</article>' : '';
    const messages = draft.messages.map((message, index) => `<article class="life-chat-bubble ${message.role}"><span>${message.role === 'user' ? '我' : '拾光'}</span>${esc(message.content)}${failedMessageIndex === index ? '<div class="life-chat-failed">发送失败 <button class="chip" data-life-chat-retry>重试</button></div>' : ''}</article>`).join('');
    const card = readyToSummarize ? `<section class="life-summary-card"><strong>已经有一个值得留下的片段了</strong><p>想把这段话整理成一条记录吗？</p><div><button class="btn primary" data-life-chat-summary>生成记录</button><button class="btn ghost" data-life-chat-continue>再聊聊</button></div></section>` : '';
    messagesEl.innerHTML = `${welcome}${messages}${card}`;
    messagesEl.querySelector('[data-life-chat-retry]')?.addEventListener('click', () => { if (failedMessageIndex != null) void requestTurn(failedMessageIndex); });
    messagesEl.querySelector('[data-life-chat-summary]')?.addEventListener('click', () => {
      if (draft.summaryProposal?.sourceMessageCount === draft.messages.length) openSummary();
      else void summarize();
    });
    messagesEl.querySelector('[data-life-chat-continue]')?.addEventListener('click', () => { readyToSummarize = false; render(); });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function renderPhotos(): void {
    host.querySelector('#life-chat-photos')!.innerHTML = draft.photos.map((photo, index) => `<div><img src="${photo.dataUrl}" alt="待发送照片 ${index + 1}"><button class="chip" data-life-chat-remove-photo="${index}" aria-label="移除待发送照片 ${index + 1}">移除</button></div>`).join('');
    host.querySelectorAll<HTMLButtonElement>('[data-life-chat-remove-photo]').forEach(button => button.onclick = () => {
      draft.photos.splice(Number(button.dataset.lifeChatRemovePhoto), 1);
      draft.summaryProposal = undefined; readyToSummarize = false; persistQuiet(); renderPhotos(); render();
    });
  }
  function setBusy(value: boolean): void {
    sending = value;
    input.disabled = value;
    host.querySelector<HTMLButtonElement>('[data-life-chat-send]')!.hidden = value;
    host.querySelector<HTMLButtonElement>('[data-life-chat-stop]')!.hidden = !value;
    host.querySelector<HTMLButtonElement>('[data-life-chat-photo]')!.disabled = value;
  }
  async function addPhotos(files: FileList | null): Promise<void> {
    if (!files?.length || sending) return;
    if (files.length + draft.photos.length > 9) { showToast('每次最多添加 9 张照片'); return; }
    try {
      for (const file of Array.from(files)) { await prepareReceipt(file); draft.photos.push({ name: file.name, dataUrl: await dataUrl(file) }); }
      draft.summaryProposal = undefined; readyToSummarize = false;
      await persist(); renderPhotos(); render();
    } catch (error) { status(error instanceof Error ? error.message : '照片添加失败'); }
  }
  async function authorise(preview: string, photos: string[], signal: AbortSignal): Promise<Destination | false> {
    const destination = await getLifeAiDestination();
    const unchanged = authorisedDestination?.baseUrl === destination.baseUrl && authorisedDestination.model === destination.model;
    const photoSignature = photos.join('\u0000');
    if (unchanged && (!photos.length || photoSignature === authorisedPhotoSignature)) return destination;
    const accepted = await confirmLifeAi(preview, signal);
    if (accepted) {
      authorisedDestination = accepted;
      authorisedPhotoSignature = photos.length ? photoSignature : undefined;
    }
    return accepted;
  }
  function sourcePreview(photos: string[]): string {
    return [...draft.messages.map(message => `${message.role === 'user' ? '我' : '拾光'}：${message.content}`), `照片：${photos.length} 张${photos.length ? '（仅本条消息附件）' : '，不发送图片'}`].join('\n');
  }
  async function send(): Promise<void> {
    if (sending || disposed || (!input.value.trim() && !draft.photos.length)) return;
    if (draft.aiExcluded || existing?.aiExcluded) { status('这条记录已排除 AI，不能发送对话。'); return; }
    const text = input.value.trim() || '（一张照片）';
    draft.messages.push({ role: 'user', content: text });
    input.value = '';
    readyToSummarize = false;
    failedMessageIndex = undefined;
    await persist(); // 请求之前先让用户消息落到本地。
    render();
    await requestTurn(draft.messages.length - 1);
  }
  async function requestTurn(messageIndex: number): Promise<void> {
    if (sending || disposed) return;
    if (draft.aiExcluded || existing?.aiExcluded) { status('这条记录已排除 AI，不能发送对话。'); return; }
    controller = new AbortController();
    const signal = controller.signal;
    const photos = [...draft.photos.map(photo => photo.dataUrl)];
    setBusy(true);
    try {
      const expectedDestination = await authorise(sourcePreview(photos), photos, signal);
      if (!expectedDestination || disposed) { failedMessageIndex = messageIndex; status('未发送，消息和照片仍保存在本机。'); render(); return; }
      status('拾光正在想…');
      const turn = await continueLifeChat({ body: '', messages: structuredClone(draft.messages), photos, signal, noteId: draft.noteId, sourceUpdatedAt: draft.sourceUpdatedAt, expectedDestination });
      if (disposed || signal.aborted) return;
      draft.messages.push({ role: 'assistant', content: turn.reply });
      draft.photos = []; // 附件只属于本条消息，成功发送后不自动用于下一条。
      failedMessageIndex = undefined;
      readyToSummarize = turn.readyToSummarize;
      await persist();
      status(''); renderPhotos(); render();
    } catch (error) {
      failedMessageIndex = messageIndex;
      status(signal.aborted ? '已停止，消息仍保留在本机。' : '发送失败，可重试。');
      render();
    } finally {
      if (!disposed) setBusy(false);
      controller = undefined;
    }
  }
  async function summarize(): Promise<void> {
    if (sending || disposed) return;
    if (draft.aiExcluded || existing?.aiExcluded) { status('这条记录已排除 AI，不能生成摘要。'); return; }
    controller = new AbortController();
    const signal = controller.signal;
    setBusy(true);
    try {
      const expectedDestination = await authorise(sourcePreview([]), [], signal);
      if (!expectedDestination || disposed) return;
      status('正在整理成一条记录…');
      draft.summaryProposal = await generateLifeSummary({ body: '', messages: structuredClone(draft.messages), signal, noteId: draft.noteId, sourceUpdatedAt: draft.sourceUpdatedAt, expectedDestination });
      await persist();
      openSummary();
    } catch (error) { status(signal.aborted ? '已停止，原始对话仍保留。' : error instanceof Error ? error.message : '暂时无法整理，请重试'); }
    finally { if (!disposed) setBusy(false); controller = undefined; }
  }
  function openSummary(): void {
    openLifeSummarySheet({
      draft,
      persist,
      onReturn: () => { if (!disposed) render(); },
      regenerate: async () => { await summarize(); },
      save: async () => {
        await persist();
        await saveLifeDraft(draft.key);
        closeSheet();
        closeSubpage();
        showToast('这一刻，留下了');
      },
    });
  }

  host.querySelector('[data-life-chat-photo]')!.addEventListener('click', () => host.querySelector<HTMLInputElement>('#lchat-file')!.click());
  host.querySelector<HTMLInputElement>('#lchat-file')!.onchange = event => { void addPhotos((event.target as HTMLInputElement).files); };
  host.querySelector('[data-life-chat-send]')!.addEventListener('click', () => { void send(); });
  host.querySelector('[data-life-chat-stop]')!.addEventListener('click', () => controller?.abort());
  input.oninput = persistQuiet;
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } });
  renderPhotos();
  render();
}

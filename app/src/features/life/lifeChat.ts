import { esc } from '../../core/esc';
import type { LifeDraft, LifeNote } from '../../core/types';
import { getAttachment, getLifeNote } from '../../core/repo/lifeRepo';
import { claimLegacyLifeChatDraft, getLifeDraft, migrateLifeDraft, putLifeDraft, saveLifeDraft } from '../../core/repo/lifeDraftRepo';
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
interface Launch { draft: LifeDraft; existing?: LifeNote; sessionVersion: number; }
let pendingLaunch: Launch | undefined;
const unsavedChatDrafts = new Map<string, LifeDraft>();
const draftWriteQueues = new Map<string, Promise<void>>();
const chatSessionVersions = new Map<string, number>();

function nextSessionVersion(key: string): number {
  const version = (chatSessionVersions.get(key) ?? 0) + 1;
  chatSessionVersions.set(key, version);
  return version;
}

function enqueueDraftWrite(key: string, task: () => Promise<void>): Promise<void> {
  const previous = draftWriteQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  draftWriteQueues.set(key, current);
  void current.finally(() => { if (draftWriteQueues.get(key) === current) draftWriteQueues.delete(key); }).catch(() => {});
  return current;
}

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
    review: existing?.review ? structuredClone(existing.review) : undefined,
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
    const stored = unsavedChatDrafts.get(key) ?? await getLifeDraft(key) ?? await claimLegacyLifeChatDraft(key, existing ? [`note:${existing.id}`] : ['new']);
    const draft = stored ? migrateLifeDraft(stored) : newDraft(key, existing);
    if (existing && !draft.messages.length) draft.messages = structuredClone(existing.conversation ?? []);
    pendingLaunch = { draft, existing, sessionVersion: nextSessionVersion(key) };
    openSubpage('sp-life-chat');
  } catch (error) { showToast(error instanceof Error ? error.message : '对话暂时打不开'); }
}

function renderChat(host: HTMLElement, launch: Launch): void {
  const { draft, existing, sessionVersion } = launch;
  let disposed = false;
  let sending = false;
  let readyToSummarize = !!draft.summaryProposal;
  let summaryCardHidden = false;
  let saved = false;
  let failedMessageIndex: number | undefined;
  let controller: AbortController | undefined;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let authorisedDestination: Destination | undefined;
  const messagePhotoUrls = new Map<number, string>();
  const isCurrentSession = () => chatSessionVersions.get(draft.key) === sessionVersion;
  const stageDraft = (): LifeDraft => {
    const copy = structuredClone(draft);
    unsavedChatDrafts.set(draft.key, copy);
    return copy;
  };
  const persist = async (): Promise<void> => {
    if (!isCurrentSession() || saved) return;
    const copy = stageDraft();
    await enqueueDraftWrite(draft.key, async () => {
      if (!isCurrentSession() || saved) return;
      await putLifeDraft(copy);
      if (unsavedChatDrafts.get(draft.key) === copy) unsavedChatDrafts.delete(draft.key);
      if (!disposed) host.querySelector<HTMLElement>('#life-chat-draft-status')!.textContent = '本地草稿已保存';
    });
  };
  const persistQuiet = () => {
    if (!isCurrentSession() || saved) return;
    stageDraft();
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { void persist().catch(() => {
      if (!disposed) host.querySelector<HTMLElement>('#life-chat-draft-status')!.textContent = '草稿待保存';
      showToast('草稿暂存在当前页面，请勿刷新；可重新打开重试保存');
    }); }, 220);
  };
  const observer = new MutationObserver(() => { if (!host.isConnected && !disposed) dispose(); });
  observer.observe(document.body, { childList: true, subtree: true });
  const off = on('settings-changed', () => { void getSetting('life.aiEnabled').then(enabled => { if (!enabled) controller?.abort(); }); });

  host.classList.add('life-chat-page');
  host.innerHTML = `<div class="life-chat" aria-label="和拾光聊聊">
    <div id="life-chat-messages" class="life-chat-messages" aria-live="polite"></div>
    <p id="life-chat-draft-status" class="life-chat-draft-status">本地草稿</p><p id="life-chat-status" class="life-chat-status" role="status"></p>
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
  input.value = draft.pendingReply ?? '';
  const status = (text: string) => { if (!disposed) host.querySelector<HTMLElement>('#life-chat-status')!.textContent = text; };

  function dispose(): void {
    disposed = true;
    clearTimeout(persistTimer);
    controller?.abort();
    observer.disconnect();
    off();
    for (const url of messagePhotoUrls.values()) URL.revokeObjectURL(url);
    messagePhotoUrls.clear();
    if (!saved) void persist().catch(() => {});
  }
  function render(): void {
    const welcome = !draft.messages.length ? '<article class="life-chat-bubble assistant"><span>拾光</span>今天有什么小事，想让我陪你留一下？</article>' : '';
    const messages = draft.messages.map((message, index) => {
      const sources = [...(message.photos ?? []).map(photo => photo.dataUrl), ...(message.photoRefs ?? []).map(ref => messagePhotoUrls.get(ref)).filter((url): url is string => !!url)];
      return `<article class="life-chat-bubble ${message.role}"><span>${message.role === 'user' ? '我' : '拾光'}</span>${esc(message.content)}${sources.length ? `<div class="life-chat-message-photos">${sources.map((src, photoIndex) => `<img src="${src}" alt="本轮照片 ${photoIndex + 1}">`).join('')}</div>` : ''}${failedMessageIndex === index ? '<div class="life-chat-failed">发送失败 <button class="chip" data-life-chat-retry>重试</button></div>' : ''}</article>`;
    }).join('');
    const proposalStale = !!draft.summaryProposal && (draft.summaryProposal.sourceMessageCount < draft.messages.length || draft.photos.length > 0);
    const card = !summaryCardHidden && (readyToSummarize || draft.summaryProposal) ? `<section class="life-summary-card"><strong>${proposalStale ? '已有建议稿，对话已有新内容' : draft.summaryProposal ? '已有一版建议稿' : '已经有一个值得留下的片段了'}</strong><p>${proposalStale ? '建议稿不会自动覆盖你的修改；需要时可手动重新整理。' : '想把这段话整理成一条记录吗？'}</p><div><button class="btn primary" data-life-chat-summary>${draft.summaryProposal ? '查看建议稿' : '生成记录'}</button><button class="btn ghost" data-life-chat-continue>再聊聊</button></div></section>` : '';
    messagesEl.innerHTML = `${welcome}${messages}${card}`;
    messagesEl.querySelector('[data-life-chat-retry]')?.addEventListener('click', () => { if (failedMessageIndex != null) void requestTurn(failedMessageIndex); });
    messagesEl.querySelector('[data-life-chat-summary]')?.addEventListener('click', () => { if (draft.summaryProposal) openSummary(); else void summarize(); });
    messagesEl.querySelector('[data-life-chat-continue]')?.addEventListener('click', () => { readyToSummarize = false; summaryCardHidden = true; render(); });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  async function loadMessagePhotos(): Promise<void> {
    const refs = [...new Set(draft.messages.flatMap(message => message.photoRefs ?? []))];
    for (const ref of refs) {
      if (disposed || messagePhotoUrls.has(ref)) continue;
      const attachment = await getAttachment(ref);
      if (disposed) return;
      if (attachment?.blob) messagePhotoUrls.set(ref, URL.createObjectURL(attachment.blob));
    }
    if (!disposed) render();
  }
  function renderPhotos(): void {
    host.querySelector('#life-chat-photos')!.innerHTML = draft.photos.map((photo, index) => `<div><img src="${photo.dataUrl}" alt="待发送照片 ${index + 1}"><button class="chip" data-life-chat-remove-photo="${index}" aria-label="移除待发送照片 ${index + 1}">移除</button></div>`).join('');
    host.querySelectorAll<HTMLButtonElement>('[data-life-chat-remove-photo]').forEach(button => button.onclick = () => {
      draft.photos.splice(Number(button.dataset.lifeChatRemovePhoto), 1);
      draft.summaryProposal = undefined; readyToSummarize = false; status('照片已移除，旧建议稿已清除。'); persistQuiet(); renderPhotos(); render();
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
    const sentPhotoCount = draft.messages.reduce((count, message) => count + (message.photos?.length ?? 0), 0);
    if (files.length + draft.photos.length + draft.existingPhotoRefs.length + sentPhotoCount > 9) { showToast('这条记录最多保留 9 张照片'); return; }
    try {
      for (const file of Array.from(files)) { await prepareReceipt(file); draft.photos.push({ name: file.name, dataUrl: await dataUrl(file) }); }
      const hadProposal = !!draft.summaryProposal;
      draft.summaryProposal = undefined; readyToSummarize = false;
      await persist(); renderPhotos(); render();
      if (hadProposal) status('已添加照片，旧建议稿已清除。');
    } catch (error) { status(error instanceof Error ? error.message : '照片添加失败'); }
  }
  async function authorise(preview: string, photos: string[], signal: AbortSignal): Promise<Destination | false> {
    const destination = await getLifeAiDestination();
    const unchanged = authorisedDestination?.baseUrl === destination.baseUrl && authorisedDestination.model === destination.model;
    if (unchanged && !photos.length) return destination;
    const accepted = await confirmLifeAi(preview, signal);
    if (accepted) {
      authorisedDestination = accepted;
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
    const photos = structuredClone(draft.photos);
    draft.messages.push({ role: 'user', content: text, photos: photos.length ? photos : undefined });
    draft.photos = [];
    input.value = '';
    draft.pendingReply = undefined;
    readyToSummarize = false; summaryCardHidden = false;
    failedMessageIndex = undefined;
    renderPhotos(); render();
    try { await persist(); }
    catch { status('草稿暂存在当前页面，请勿刷新；可重试保存。'); }
    await requestTurn(draft.messages.length - 1);
  }
  async function requestTurn(messageIndex: number): Promise<void> {
    if (sending || disposed) return;
    if (draft.aiExcluded || existing?.aiExcluded) { status('这条记录已排除 AI，不能发送对话。'); return; }
    controller = new AbortController();
    const signal = controller.signal;
    const photos = [...(draft.messages[messageIndex]?.photos ?? []).map(photo => photo.dataUrl)];
    setBusy(true);
    try {
      const expectedDestination = await authorise(sourcePreview(photos), photos, signal);
      if (!expectedDestination || disposed) { failedMessageIndex = messageIndex; status('未发送，消息和照片仍保存在本机。'); render(); return; }
      status('拾光正在想…');
      const turn = await continueLifeChat({ body: '', messages: structuredClone(draft.messages), photos, signal, noteId: draft.noteId, sourceUpdatedAt: draft.sourceUpdatedAt, expectedDestination });
      if (disposed || signal.aborted) return;
      draft.messages.push({ role: 'assistant', content: turn.reply });
      failedMessageIndex = undefined;
      readyToSummarize = turn.readyToSummarize;
      try { await persist(); }
      catch { status('回复已留在当前页面，请勿刷新；可重新打开后继续保存。'); render(); return; }
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
        clearTimeout(persistTimer);
        await persist();
        await saveLifeDraft(draft.key);
        saved = true;
        unsavedChatDrafts.delete(draft.key);
        if (isCurrentSession()) chatSessionVersions.set(draft.key, sessionVersion + 1);
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
  input.oninput = () => { draft.pendingReply = input.value; persistQuiet(); };
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } });
  renderPhotos();
  render();
  void loadMessagePhotos();
}

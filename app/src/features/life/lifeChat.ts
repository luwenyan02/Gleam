import { esc } from '../../core/esc';
import type { LifeDraft, LifeNote } from '../../core/types';
import { getAttachment, getLifeNote } from '../../core/repo/lifeRepo';
import { claimLegacyLifeChatDraft, getLifeDraft, listLifeChatSessions, migrateLifeDraft, putLifeDraft, saveLifeDraft } from '../../core/repo/lifeDraftRepo';
import { continueLifeChat, generateLifeSummary, getLifeAiDestination } from '../../core/repo/lifeAiRepo';
import { on } from '../../core/store';
import { getSetting } from '../../core/repo/settingsRepo';
import { prepareReceipt } from '../entry/receiptEditor';
import { confirmLifeAi } from './lifeAiConsent';
import { registerSubpage, openSubpage, closeSubpage } from '../shell/router';
import { closeSheet, openSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { openLifeSummarySheet } from './lifeSummarySheet';
import './lifeAi.css';
import './lifeChat.css';
import { renderChatText } from './chatText';
import { openLifeVoice } from './lifeVoice';
import { chatIcon } from './chatIcons';
import { formatChatReplyTime } from './chatReplyTime';
import { openAiSettings } from '../settings/settings';
import { AiConfigError } from '../../core/repo/aiRepo';

const needsAiConfig = (error: unknown): boolean => error instanceof AiConfigError
  || (error instanceof Error && error.message === '请先在设置中配置 AI 接口和模型');

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
    const latest = existing ? undefined : (await listLifeChatSessions()).find(session => !session.saved);
    const key = existing ? `chat:note:${existing.id}` : latest?.key ?? 'chat:new';
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
  let streamedReply = '';
  let stopVoice: (() => void) | undefined;
  const messagePhotoUrls = new Map<number, string>();
  const isCurrentSession = () => chatSessionVersions.get(draft.key) === sessionVersion;
  const stageDraft = (): LifeDraft => {
    draft.chatUpdatedAt = Date.now();
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
  const off = on('settings-changed', () => { void getSetting('life.aiEnabled').then(enabled => { if (!enabled) { controller?.abort(); stopVoice?.(); } }); });

  host.classList.add('life-chat-page');
  const header = host.parentElement!.querySelector('.sub-head')!;
  header.querySelector('.chat-head-actions')?.remove();
  header.querySelector('h2')!.innerHTML = '<span class="chat-brand"><span class="chat-brand-name">拾光</span><em>AI</em></span><small title="聊聊想法与日常">聊聊想法与日常</small>';
  header.insertAdjacentHTML('beforeend', `<div class="chat-head-actions"><button data-chat-start aria-label="新聊天" title="新聊天">${chatIcon('compose')}<span>新聊天</span></button><button data-chat-settings aria-label="AI 设置" title="AI 设置">${chatIcon('settings')}<span>AI 设置</span></button><button data-chat-history aria-label="历史会话" title="历史会话">${chatIcon('history')}<span>会话</span></button></div>`);
  host.innerHTML = `<div class="life-chat" aria-label="和拾光聊聊">
    <div id="life-chat-messages" class="life-chat-messages" aria-live="polite"></div>
    <button class="chat-jump" data-chat-jump hidden aria-label="回到最新消息" title="回到最新消息">${chatIcon('down')}</button>
    <p id="life-chat-draft-status" class="life-chat-draft-status sr-only">本地草稿</p><p id="life-chat-status" class="life-chat-status" role="status"></p>
    <button class="chat-config-link" data-chat-config-error hidden>${chatIcon('settings')}<span>配置 AI 接口</span></button>
    <div class="life-chat-input-wrap">
      <div class="life-chat-photos" id="life-chat-photos"></div>
      <input id="lchat-file" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden>
      <label class="sr-only" for="life-chat-input">和拾光说说</label><textarea id="life-chat-input" rows="1" maxlength="8000" placeholder="想说什么，都可以…"></textarea>
      <div class="chat-compose-tools"><button data-life-chat-photo aria-label="添加照片" title="添加照片">${chatIcon('photo')}<span>照片</span></button><button data-chat-voice aria-label="实时语音" title="实时语音">${chatIcon('voice')}<span>语音聊</span></button><button data-chat-organize aria-label="整理成记录" title="整理成记录">${chatIcon('bookmark')}<span>整理</span></button><button class="btn primary life-chat-send" data-life-chat-send aria-label="发送" title="发送">${chatIcon('send')}</button><button class="btn ghost life-chat-stop" data-life-chat-stop aria-label="停止" title="停止" hidden>${chatIcon('stop')}</button></div>
    </div>
    <p class="chat-footnote">AI 也会出错，请核实重要信息</p>
  </div>`;
  const messagesEl = host.querySelector<HTMLElement>('#life-chat-messages')!;
  const composerResize = new ResizeObserver(() => {
    const chat = host.querySelector<HTMLElement>('.life-chat')!;
    chat.style.setProperty('--chat-composer-height', `${chat.clientHeight - messagesEl.offsetHeight}px`);
  });
  composerResize.observe(messagesEl);
  const input = host.querySelector<HTMLTextAreaElement>('#life-chat-input')!;
  input.value = draft.pendingReply ?? '';
  const status = (text: string, configure = false) => {
    if (disposed) return;
    host.querySelector<HTMLElement>('#life-chat-status')!.textContent = text;
    host.querySelector<HTMLButtonElement>('[data-chat-config-error]')!.hidden = !configure;
  };

  function dispose(): void {
    disposed = true;
    clearTimeout(persistTimer);
    controller?.abort();
    stopVoice?.();
    observer.disconnect();
    composerResize.disconnect();
    off();
    for (const url of messagePhotoUrls.values()) URL.revokeObjectURL(url);
    messagePhotoUrls.clear();
    if (!saved) void persist().catch(() => {});
  }
  function render(forceBottom = true): void {
    syncComposer();
    const scrollTop = messagesEl.scrollTop;
    const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
    const welcome = !draft.messages.length ? `<section class="chat-welcome"><div class="chat-welcome-heading"><div class="chat-emblem" aria-hidden="true">${chatIcon('spark')}</div><div><div class="chat-eyebrow">一处随时能坐坐的地方</div><h3>你好，我是拾光</h3></div></div><p>今天有什么小事，或突然冒出的想法？<br>可以一起琢磨，也可以只是聊聊。</p><div class="chat-starters"><button data-chat-prompt="今天有件小事，想和你聊聊。"><i>${chatIcon('chat')}</i>聊聊今天</button><button data-chat-prompt="我有一个想法，想请你帮我一起想想。"><i>${chatIcon('idea')}</i>帮我想想</button><button data-chat-prompt="我有个问题，想请你解释一下："><i>${chatIcon('question')}</i>解答问题</button><button data-chat-prompt="帮我润色下面这段话，保留我的意思："><i>${chatIcon('compose')}</i>润色文字</button></div><div class="chat-welcome-note">不必每天来，想说的时候我都在。</div></section>` : '';
    const messages = draft.messages.map((message, index) => {
      const sources = [...(message.photos ?? []).map(photo => photo.dataUrl), ...(message.photoRefs ?? []).map(ref => messagePhotoUrls.get(ref)).filter((url): url is string => !!url)];
      const replyTime = formatChatReplyTime(message.repliedAt);
      const actions = message.role === 'assistant' ? `<div class="chat-message-actions"><button data-chat-copy="${index}" aria-label="复制第 ${index + 1} 条消息" title="复制">${chatIcon('copy')}</button>${index === draft.messages.length - 1 ? `<button data-chat-regenerate aria-label="重新回答" title="重新回答">${chatIcon('retry')}</button>` : ''}${replyTime ? `<time class="chat-reply-time" datetime="${new Date(message.repliedAt!).toISOString()}" title="${esc(new Date(message.repliedAt!).toLocaleString())}" aria-label="回复时间 ${replyTime}">${replyTime}</time>` : ''}</div>` : '';
      return `<article class="life-chat-bubble ${message.role}">${message.role === 'assistant' ? `<div class="chat-speaker"><i aria-hidden="true">${chatIcon('spark')}</i>拾光 AI</div>` : ''}<div class="chat-message-content"><div class="chat-message-text">${message.role === 'user' ? esc(message.content) : renderChatText(message.content)}</div>${sources.length ? `<div class="life-chat-message-photos">${sources.map((src, photoIndex) => `<img src="${src}" alt="本轮照片 ${photoIndex + 1}">`).join('')}</div>` : ''}</div>${actions}${failedMessageIndex === index ? '<div class="life-chat-failed">未完成 <button class="chip" data-life-chat-retry>重试</button></div>' : ''}</article>`;
    }).join('');
    const proposalStale = !!draft.summaryProposal && (draft.summaryProposal.sourceMessageCount < draft.messages.length || draft.photos.length > 0);
    const card = !summaryCardHidden && (readyToSummarize || draft.summaryProposal) ? `<section class="life-summary-card"><strong>${proposalStale ? '已有建议稿，对话已有新内容' : draft.summaryProposal ? '已有一版建议稿' : '已经有一个值得留下的片段了'}</strong><p>${proposalStale ? '建议稿不会自动覆盖你的修改；需要时可手动重新整理。' : '想把这段话整理成一条记录吗？'}</p><div><button class="btn primary" data-life-chat-summary>${draft.summaryProposal ? '查看建议稿' : '生成记录'}</button><button class="btn ghost" data-life-chat-continue>再聊聊</button></div></section>` : '';
    messagesEl.innerHTML = `${welcome}${messages}${streamedReply ? `<article class="life-chat-bubble assistant chat-streaming"><div class="chat-speaker"><i aria-hidden="true">${chatIcon('spark')}</i>拾光 AI</div><div class="chat-message-content"><div class="chat-message-text">${renderChatText(streamedReply)}</div></div></article>` : ''}${card}`;
    // 尾行保留操作区宽度，按钮在气泡内右对齐，不再单独占据气泡外的一行。
    messagesEl.querySelectorAll<HTMLElement>('.chat-message-actions').forEach(actions => {
      const content = actions.parentElement!.querySelector<HTMLElement>('.chat-message-content')!;
      const text = content.querySelector<HTMLElement>('.chat-message-text')!;
      const slot = document.createElement('span');
      slot.className = 'chat-action-slot';
      slot.setAttribute('aria-hidden', 'true');
      slot.style.width = `${actions.querySelectorAll('button').length * 44 + (actions.querySelector('.chat-reply-time') ? 52 : 0) + 8}px`;
      let tail = text.lastElementChild as HTMLElement | null;
      while (tail?.matches('ul,ol,li') && tail.lastElementChild?.matches('ul,ol,li,p')) tail = tail.lastElementChild as HTMLElement;
      if (content.querySelector('.life-chat-message-photos') || tail?.matches('pre,.chat-table-scroll,hr')) {
        slot.classList.add('chat-action-slot-block');
        content.append(slot);
      } else if (actions.parentElement!.classList.contains('user')) text.append(slot);
      else (tail ?? text).append(slot);
      content.append(actions);
    });
    messagesEl.querySelectorAll<HTMLButtonElement>('[data-chat-prompt]').forEach(button => button.onclick = () => { input.value = button.dataset.chatPrompt!; input.dispatchEvent(new Event('input')); input.focus(); });
    messagesEl.querySelectorAll<HTMLButtonElement>('[data-chat-copy]').forEach(button => button.onclick = () => {
      void navigator.clipboard.writeText(draft.messages[Number(button.dataset.chatCopy)].content).then(() => {
        button.innerHTML = chatIcon('check'); button.title = '已复制'; showToast('已复制');
        setTimeout(() => { if (button.isConnected) { button.innerHTML = chatIcon('copy'); button.title = '复制'; } }, 1600);
      }).catch(() => showToast('复制失败，可长按选择文字'));
    });
    messagesEl.querySelector('[data-chat-regenerate]')?.addEventListener('click', () => { void requestTurn(draft.messages.length - 2, true); });
    messagesEl.querySelector('[data-life-chat-retry]')?.addEventListener('click', () => { if (failedMessageIndex != null) void requestTurn(failedMessageIndex); });
    messagesEl.querySelector('[data-life-chat-summary]')?.addEventListener('click', () => { if (draft.summaryProposal) openSummary(); else void summarize(); });
    messagesEl.querySelector('[data-life-chat-continue]')?.addEventListener('click', () => { readyToSummarize = false; summaryCardHidden = true; render(); });
    messagesEl.scrollTop = forceBottom || nearBottom ? messagesEl.scrollHeight : scrollTop;
    host.querySelector<HTMLButtonElement>('[data-chat-jump]')!.hidden = forceBottom || nearBottom;
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
    syncComposer();
    host.querySelector('#life-chat-photos')!.innerHTML = draft.photos.map((photo, index) => `<div><img src="${photo.dataUrl}" alt="待发送照片 ${index + 1}"><button class="chip" data-life-chat-remove-photo="${index}" aria-label="移除待发送照片 ${index + 1}">移除</button></div>`).join('');
    host.querySelectorAll<HTMLButtonElement>('[data-life-chat-remove-photo]').forEach(button => button.onclick = () => {
      draft.photos.splice(Number(button.dataset.lifeChatRemovePhoto), 1);
      draft.summaryProposal = undefined; readyToSummarize = false; status('照片已移除，旧建议稿已清除。'); persistQuiet(); renderPhotos(); render();
    });
  }
  function setBusy(value: boolean): void {
    sending = value;
    host.querySelector<HTMLButtonElement>('[data-chat-config-error]')!.disabled = value;
    host.classList.toggle('is-chat-busy', value);
    input.disabled = value;
    syncComposer();
    host.querySelector<HTMLButtonElement>('[data-life-chat-stop]')!.hidden = !value;
    host.querySelector<HTMLButtonElement>('[data-life-chat-photo]')!.disabled = value;
    host.querySelector<HTMLButtonElement>('[data-chat-voice]')!.disabled = value;
    header.querySelectorAll<HTMLButtonElement>('button:not([data-act="back"])').forEach(button => { button.disabled = value; });
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
    resizeInput();
    draft.pendingReply = undefined;
    readyToSummarize = false; summaryCardHidden = false;
    failedMessageIndex = undefined;
    renderPhotos(); render();
    try { await persist(); }
    catch { status('草稿暂存在当前页面，请勿刷新；可重试保存。'); }
    await requestTurn(draft.messages.length - 1);
  }
  async function requestTurn(messageIndex: number, regenerate = false): Promise<void> {
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
      const turn = await continueLifeChat({ body: '', messages: structuredClone(draft.messages.slice(0, messageIndex + 1)), photos, signal, noteId: draft.noteId, sourceUpdatedAt: draft.sourceUpdatedAt, expectedDestination,
        onDelta: text => { if (!disposed && !signal.aborted) { streamedReply = text; status('正在回复…'); render(false); } },
      });
      if (disposed || signal.aborted) return;
      streamedReply = '';
      if (regenerate) draft.messages.splice(messageIndex + 1);
      draft.messages.push({ role: 'assistant', content: turn.reply, repliedAt: Date.now() });
      failedMessageIndex = undefined;
      // 是否整理由用户决定，不因模型的旧版就绪标志弹出劝记卡片。
      readyToSummarize = false;
      try { await persist(); }
      catch { status('回复已留在当前页面，请勿刷新；可重新打开后继续保存。'); render(); return; }
      status(''); renderPhotos(); render();
    } catch (error) {
      streamedReply = '';
      failedMessageIndex = messageIndex;
      status(signal.aborted ? '已停止，消息仍保留在本机。' : error instanceof Error ? error.message : '发送失败，可重试。', !signal.aborted && needsAiConfig(error));
      render();
    } finally {
      if (!disposed) setBusy(false);
      controller = undefined;
    }
  }

  async function switchSession(key: string, noteId?: number): Promise<void> {
    if (sending || disposed) return;
    try {
      await persist();
      const note = noteId == null ? undefined : await getLifeNote(noteId);
      if (noteId != null && (!note || note.deletedAt)) throw new Error('记录已删除');
      const stored = unsavedChatDrafts.get(key) ?? await getLifeDraft(key);
      dispose();
      renderChat(host, { draft: stored ? migrateLifeDraft(stored) : newDraft(key, note), existing: note, sessionVersion: nextSessionVersion(key) });
    } catch { showToast('会话切换失败，当前内容仍保留'); }
  }

  async function showHistory(): Promise<void> {
    try {
      await persist();
      const sessions = await listLifeChatSessions();
      if (disposed) return;
      openSheet({ ariaLabel: '历史会话', render(el) {
        el.innerHTML = `<div class="sheet-head"><h3>历史会话</h3><button class="icon-btn" data-history-close aria-label="关闭历史会话">×</button></div><div class="sheet-scroll chat-history"><label class="sr-only" for="chat-history-search">搜索会话</label><input id="chat-history-search" class="note" placeholder="搜索会话标题"><div id="chat-history-list"></div></div>`;
        const list = el.querySelector('#chat-history-list')!;
        const paint = (query = '') => {
          const matches = sessions.filter(session => session.title.includes(query));
          list.innerHTML = matches.length ? matches.map((session, index) => `<button class="chat-history-row" data-history-index="${index}" ${session.key === draft.key ? 'aria-current="true"' : ''}><strong>${esc(session.title)}</strong><small>${new Date(session.updatedAt).toLocaleDateString('zh-CN')} · ${session.saved ? '已整理成记录' : '本地会话'}</small></button>`).join('') : '<p class="sub">没有匹配的会话</p>';
          list.querySelectorAll<HTMLButtonElement>('[data-history-index]').forEach(button => button.onclick = () => { const session = matches[Number(button.dataset.historyIndex)]; closeSheet(); void switchSession(session.key, session.noteId); });
        };
        el.querySelector('[data-history-close]')!.addEventListener('click', closeSheet);
        el.querySelector<HTMLInputElement>('#chat-history-search')!.oninput = event => paint((event.target as HTMLInputElement).value.trim());
        paint();
      } });
    } catch { showToast('暂时无法读取历史会话'); }
  }

  function syncComposer(): void {
    const hasInput = !!input.value.trim() || draft.photos.length > 0;
    host.querySelector<HTMLButtonElement>('[data-life-chat-send]')!.hidden = sending;
    host.querySelector<HTMLButtonElement>('[data-life-chat-send]')!.disabled = sending || !hasInput;
    header.querySelectorAll<HTMLButtonElement>('[data-chat-start],[data-chat-settings]').forEach(button => { button.disabled = sending; });
    const organize = host.querySelector<HTMLButtonElement>('[data-chat-organize]')!;
    organize.disabled = sending || !draft.messages.some(message => message.role === 'user');
    organize.querySelector('span')!.textContent = draft.summaryProposal ? '草稿' : '整理';
    organize.title = draft.summaryProposal ? '查看记录草稿' : '整理成记录';
    organize.setAttribute('aria-label', organize.title);
  }
  function resizeInput(): void { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 150)}px`; syncComposer(); }
  header.querySelector<HTMLButtonElement>('[data-chat-history]')!.onclick = () => { void showHistory(); };
  header.querySelector('[data-chat-start]')!.addEventListener('click', () => { void switchSession(`chat:session:${crypto.randomUUID()}`); });
  header.querySelector('[data-chat-settings]')!.addEventListener('click', openAiSettings);
  host.querySelector('[data-chat-organize]')!.addEventListener('click', () => { if (draft.summaryProposal) openSummary(); else void summarize(); });
  host.querySelector('[data-chat-config-error]')!.addEventListener('click', openAiSettings);
  host.querySelector('[data-chat-jump]')!.addEventListener('click', () => { messagesEl.scrollTop = messagesEl.scrollHeight; host.querySelector<HTMLButtonElement>('[data-chat-jump]')!.hidden = true; });
  messagesEl.addEventListener('scroll', () => { host.querySelector<HTMLButtonElement>('[data-chat-jump]')!.hidden = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100; });
  host.querySelector('[data-chat-voice]')!.addEventListener('click', () => {
    if (sending || draft.aiExcluded || existing?.aiExcluded) return;
    const prefix = structuredClone(draft.messages);
    stopVoice = openLifeVoice({ onTranscript: messages => { if (!disposed) { draft.messages = [...prefix, ...messages]; persistQuiet(); render(); } } });
  });
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
    } catch (error) { status(signal.aborted ? '已停止，原始对话仍保留。' : error instanceof Error ? error.message : '暂时无法整理，请重试', !signal.aborted && needsAiConfig(error)); }
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
  input.oninput = () => { draft.pendingReply = input.value; persistQuiet(); resizeInput(); };
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } });
  renderPhotos();
  render();
  void loadMessagePhotos();
  requestAnimationFrame(resizeInput);
}

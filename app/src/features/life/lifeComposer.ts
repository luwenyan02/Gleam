import { esc } from '../../core/esc';
import type { LifeDraft, LifeNote } from '../../core/types';
import { getEntry } from '../../core/repo/entryRepo';
import { getAttachment, getLifeNote, softDeleteLifeNote, listLifeLinkedEntries } from '../../core/repo/lifeRepo';
import { formatFenCny } from '../../core/money';
import { getLifeDraft, putLifeDraft, deleteLifeDraft, saveLifeDraft } from '../../core/repo/lifeDraftRepo';
import { askLifeQuestion, organizeLifeText } from '../../core/repo/lifeAiRepo';
import { on } from '../../core/store';
import { getSetting } from '../../core/repo/settingsRepo';
import { openSheet, closeSheet } from '../shell/sheet';
import { confirmDialog } from '../shell/dialog';
import { showToast } from '../shell/toast';
import { prepareReceipt } from '../entry/receiptEditor';
import { openDateWheel } from '../../shared/dateTimeWheel';
import { confirmLifeAi } from './lifeAiConsent';
import './lifeAi.css';

const queues = new Map<string, Promise<void>>();
const unsavedDrafts = new Map<string, LifeDraft>();
let opening = 0;
const dateText = (timestamp: number) => new Date(timestamp).toLocaleDateString('zh-CN');
function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('照片读取失败'));
    reader.readAsDataURL(blob);
  });
}

/** 统一入口；回到同一个上下文时恢复草稿，账单入口不覆盖其他随记草稿。 */
export async function openLifeComposer(options: { noteId?: number; entryId?: number } = {}): Promise<void> {
  const generation = ++opening;
  try {
    let noteId = options.noteId;
    const entry = options.entryId ? await getEntry(options.entryId) : undefined;
    if (options.entryId && (!entry || entry.deletedAt)) throw new Error('这笔账单已不在当前账本中');
    if (noteId == null && entry?.lifeNoteId != null) {
      const linked = await getLifeNote(entry.lifeNoteId);
      if (linked && !linked.deletedAt) noteId = linked.id;
    }
    const key = noteId ? `note:${noteId}` : options.entryId ? `entry:${options.entryId}` : 'new';
    await queues.get(key)?.catch(() => {});
    const existing = noteId ? await getLifeNote(noteId) : undefined;
    if (noteId && (!existing || existing.deletedAt)) throw new Error('记录已移入回收站');
    const stored = unsavedDrafts.get(key) ?? await getLifeDraft(key);
    const draft: LifeDraft = stored ?? {
      key, noteId, sourceUpdatedAt: existing?.updatedAt, entryId: options.entryId, title: existing?.title ?? '',
      body: existing?.originalBody ?? existing?.body ?? '',
      aiText: existing?.originalBody != null ? existing.body : undefined,
      occurredAt: existing?.occurredAt ?? entry?.occurredAt ?? Date.now(),
      photos: [], existingPhotoRefs: [...(existing?.photoRefs ?? [])], messages: [],
      mood: existing?.mood, tags: existing?.tags, review: existing?.review ? { ...existing.review } : undefined,
      aiExcluded: existing?.aiExcluded ?? false,
    };
    if (options.entryId != null) draft.entryId = options.entryId;
    if (generation !== opening) return;
    renderComposer(draft, existing);
  } catch (error) { showToast(error instanceof Error ? error.message : '记录暂时打不开'); }
}

function renderComposer(draft: LifeDraft, existing?: LifeNote): void {
  let disposed = false, saving = false, processing = false, discarded = false;
  let controller: AbortController | undefined;
  let host: HTMLElement;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  const urls: string[] = [];
  const persist = (): Promise<void> => {
    clearTimeout(persistTimer); persistTimer = undefined;
    const copy = structuredClone(draft);
    unsavedDrafts.set(draft.key, copy);
    const pending = (queues.get(draft.key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await putLifeDraft(copy);
      if (unsavedDrafts.get(draft.key) === copy) unsavedDrafts.delete(draft.key);
    });
    queues.set(draft.key, pending);
    const settled = () => { if (queues.get(draft.key) === pending) queues.delete(draft.key); };
    void pending.then(settled, settled);
    return pending;
  };
  const flushQuiet = () => { void persist().catch(() => { showToast('草稿暂存在当前页面，请勿刷新；可重新打开重试保存'); }); };
  const persistQuiet = () => { clearTimeout(persistTimer); persistTimer = setTimeout(flushQuiet, 250); };
  const off = on('settings-changed', () => { void getSetting('life.aiEnabled').then(enabled => { if (!enabled) controller?.abort(); }); });
  openSheet({
    ariaLabel: '留一下',
    onClose() {
      disposed = true; controller?.abort(); off(); urls.forEach(url => URL.revokeObjectURL(url));
      host.classList.remove('life-composer');
      clearTimeout(persistTimer);
      if (!saving && !discarded) flushQuiet();
    },
    render(el) {
      host = el;
      el.classList.add('life-composer');
      el.innerHTML = `<div class="lf-sheet-head"><p class="sheet-title">${existing ? '这一刻' : '留一下'}</p><button class="icon-btn" data-lc-close aria-label="关闭并保留草稿">×</button></div>
        <div class="sheet-scroll lc-scroll">
          ${draft.entryId ? '<div class="lc-linked">这一笔，也有故事 · 保存后关联原账单，不会再次记账<button class="chip" data-lc-detach>仅保存故事</button></div>' : '<p class="sub">一句话、一张照片，都可以。</p>'}
          <div id="lc-linked-entries"></div>
          <label class="sr-only" for="lc-body">想留下的话</label><textarea id="lc-body" class="note" maxlength="12000" placeholder="刚刚有什么想留住的？">${esc(draft.body)}</textarea>
          <div class="lc-row"><button class="chip" data-lc-photo>＋ 照片</button><button class="chip" data-lc-date>${dateText(draft.occurredAt)}</button></div>
          <input type="file" id="lc-file" accept="image/jpeg,image/png,image/webp" multiple hidden>
          <div class="lc-photos" id="lc-photos"></div>
          <details class="lc-details"><summary>标题与更多</summary>
            <label>标题<input class="note" id="lc-title" maxlength="60" placeholder="可以不填" value="${esc(draft.title)}"></label>
            <label>心情<select id="lc-mood"><option value="">不选也可以</option>${['开心','平静','充实','疲惫','难过'].map(m => `<option ${draft.mood === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
            <label>标签<input class="note" id="lc-tags" placeholder="散步，朋友" value="${esc((draft.tags ?? []).join('，'))}"></label>
            <label class="lc-check"><input type="checkbox" id="lc-exclude" ${draft.aiExcluded ? 'checked' : ''}>不用于 AI 或周刊</label>
          </details>
          <section class="lc-ai" aria-label="可选 AI 引导"><div class="lc-row"><button class="chip" data-lc-ask>聊两句</button><button class="chip" data-lc-organize>帮我整理</button><button class="chip" data-lc-cancel hidden>停止</button></div>
            <label class="lc-check" id="lc-image-choice" hidden><input type="checkbox" id="lc-send-images">本次也让 AI 看照片（默认不发送）</label>
            <div id="lc-chat" aria-live="polite"></div>
            <div id="lc-answer" hidden><label class="sr-only" for="lc-reply">接着说</label><textarea class="note" id="lc-reply" maxlength="2000" placeholder="愿意的话，接着说…">${esc(draft.pendingReply ?? '')}</textarea><button class="chip" data-lc-reply>继续聊</button></div>
            <div id="lc-preview" aria-live="polite"></div>
          </section>
          <details class="lc-details"><summary>这段经历，后来怎么样</summary>
            <label>现在的感受<select id="lc-verdict"><option value="">自己写，不选评价</option><option value="again">值得再来</option><option value="neutral">一般</option><option value="not-for-me">不太适合我</option></select></label>
            <label>补一句<textarea class="note" id="lc-review" maxlength="2000" placeholder="留下了什么，只有你知道">${esc(draft.review?.text ?? '')}</textarea></label>
            <div class="lc-row"><button class="chip" data-lc-revisit>${draft.review?.revisitAt ? `${dateText(draft.review.revisitAt)} 再看看` : '选一天再看看'}</button><button class="chip" data-lc-no-revisit>不提醒</button></div>
          </details>
          <p id="lc-status" class="sub" role="status"></p>
          <button class="btn primary" data-lc-save>就这样记下</button>
          <div class="lc-row lc-footer"><button class="btn ghost" data-lc-discard>丢弃草稿</button>${existing ? '<button class="btn ghost" data-lc-delete>移入回收站</button>' : ''}</div>
        </div>`;
      el.querySelector<HTMLSelectElement>('#lc-verdict')!.value = draft.review?.verdict ?? '';
      el.querySelector('[data-lc-close]')!.addEventListener('click', closeSheet);
      el.querySelector('[data-lc-detach]')?.addEventListener('click', () => { draft.entryId = undefined; el.querySelector('.lc-linked')!.textContent = '仅保存故事，不新增账单关联'; persistQuiet(); });
      el.querySelector<HTMLTextAreaElement>('#lc-body')!.oninput = event => { draft.body = (event.target as HTMLTextAreaElement).value; draft.aiText = undefined; showPreview(); persistQuiet(); };
      el.querySelector<HTMLInputElement>('#lc-title')!.oninput = event => { draft.title = (event.target as HTMLInputElement).value; persistQuiet(); };
      el.querySelector<HTMLSelectElement>('#lc-mood')!.onchange = event => { draft.mood = (event.target as HTMLSelectElement).value || undefined; persistQuiet(); };
      el.querySelector<HTMLInputElement>('#lc-tags')!.oninput = event => { draft.tags = (event.target as HTMLInputElement).value.split(/[,，]/).map(s => s.trim()).filter(Boolean); persistQuiet(); };
      el.querySelector<HTMLInputElement>('#lc-exclude')!.onchange = event => { draft.aiExcluded = (event.target as HTMLInputElement).checked; if (draft.aiExcluded) controller?.abort(); persistQuiet(); };
      el.querySelector<HTMLSelectElement>('#lc-verdict')!.onchange = event => { draft.review = { ...draft.review, verdict: (event.target as HTMLSelectElement).value as NonNullable<LifeDraft['review']>['verdict'] || undefined }; persistQuiet(); };
      el.querySelector<HTMLTextAreaElement>('#lc-review')!.oninput = event => { draft.review = { ...draft.review, text: (event.target as HTMLTextAreaElement).value }; persistQuiet(); };
      el.querySelector('[data-lc-date]')!.addEventListener('click', () => pickDate(draft.occurredAt, value => { draft.occurredAt = value; el.querySelector('[data-lc-date]')!.textContent = dateText(value); persistQuiet(); }));
      el.querySelector('[data-lc-revisit]')!.addEventListener('click', () => pickDate(draft.review?.revisitAt ?? Date.now() + 7 * 86400000, value => { draft.review = { ...draft.review, revisitAt: value, dismissedAt: undefined }; el.querySelector('[data-lc-revisit]')!.textContent = `${dateText(value)} 再看看`; persistQuiet(); }));
      el.querySelector('[data-lc-no-revisit]')!.addEventListener('click', () => { draft.review = { ...draft.review, revisitAt: undefined, dismissedAt: Date.now() }; el.querySelector('[data-lc-revisit]')!.textContent = '选一天再看看'; persistQuiet(); });
      el.querySelector('[data-lc-photo]')!.addEventListener('click', () => el.querySelector<HTMLInputElement>('#lc-file')!.click());
      el.querySelector<HTMLInputElement>('#lc-file')!.onchange = event => { void addPhotos((event.target as HTMLInputElement).files); };
      el.querySelector('[data-lc-ask]')!.addEventListener('click', () => { void aiAction('ask'); });
      el.querySelector('[data-lc-organize]')!.addEventListener('click', () => { void aiAction('organize'); });
      el.querySelector('[data-lc-reply]')!.addEventListener('click', () => {
        const reply = el.querySelector<HTMLTextAreaElement>('#lc-reply')!;
        if (!reply.value.trim()) return;
        draft.messages.push({ role: 'user', content: reply.value.trim() }); reply.value = ''; draft.pendingReply = ''; draft.aiText = undefined;
        showChat(); showPreview(); persistQuiet(); void aiAction('ask');
      });
      el.querySelector<HTMLTextAreaElement>('#lc-reply')!.oninput = event => { draft.pendingReply = (event.target as HTMLTextAreaElement).value; persistQuiet(); };
      el.querySelector('[data-lc-cancel]')!.addEventListener('click', () => controller?.abort());
      el.querySelector('[data-lc-save]')!.addEventListener('click', () => { void save(); });
      el.querySelector('[data-lc-discard]')!.addEventListener('click', () => { void discard(); });
      el.querySelector('[data-lc-delete]')?.addEventListener('click', () => { void remove(); });
      showChat(); showPreview(); void showPhotos().catch(() => status('照片暂时无法读取')); void showLinked().catch(() => status('关联账单暂时无法读取'));
    },
  });

  function pickDate(timestamp: number, accept: (timestamp: number) => void): void {
    const d = new Date(timestamp);
    const panel = openDateWheel({ initial: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }, onConfirm: r => accept(new Date(r.year, r.month - 1, r.day, 12).getTime()) });
    document.body.appendChild(panel);
  }
  async function showLinked(): Promise<void> {
    if (!draft.noteId) return;
    const entries = await listLifeLinkedEntries(draft.noteId);
    if (disposed) return;
    host.querySelector('#lc-linked-entries')!.innerHTML = entries.length ? `<details class="lc-details"><summary>关联原账单 · ${entries.length} 笔</summary>${entries.map(e => `<button class="btn ghost" data-lc-entry="${e.id}">${dateText(e.occurredAt)} · ${e.refundFlag ? '退款' : e.type === 'expense' ? '支出' : e.type === 'income' ? '收入' : '资金往来'} ${formatFenCny(e.amount)} ›</button>`).join('')}</details>` : '';
    host.querySelectorAll<HTMLButtonElement>('[data-lc-entry]').forEach(button => { button.onclick = async () => {
      try {
      await persist(); if (disposed) return; closeSheet();
      const { openEntryDetail } = await import('../detail/entrySwipe'); openEntryDetail(Number(button.dataset.lcEntry));
      } catch { showToast('暂时无法打开账单，草稿已保留'); }
    }; });
  }
  function busy(value: boolean): void {
    processing = value;
    host.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select,button').forEach(control => { if (!control.matches('[data-lc-close],[data-lc-cancel]')) control.disabled = value; });
    host.querySelector<HTMLElement>('[data-lc-cancel]')!.hidden = !value;
  }
  function status(text: string): void { if (!disposed) host.querySelector('#lc-status')!.textContent = text; }
  function showChat(): void {
    host.querySelector('#lc-chat')!.innerHTML = draft.messages.map(m => `<p class="lc-message ${m.role}"><span>${m.role === 'user' ? '我' : '拾光 AI'}</span>${esc(m.content)}</p>`).join('');
    host.querySelector<HTMLElement>('#lc-answer')!.hidden = !draft.messages.length;
  }
  function showPreview(): void {
    host.querySelector('#lc-preview')!.innerHTML = draft.aiText ? `<div class="lc-preview"><p class="sub">整理预览 · 原话会一并保留</p><label class="sr-only" for="lc-ai-text">修改整理稿</label><textarea class="note" id="lc-ai-text" maxlength="12000">${esc(draft.aiText)}</textarea><button class="chip" data-lc-original>不用整理稿，保留原话</button></div>` : '';
    host.querySelector<HTMLTextAreaElement>('#lc-ai-text')?.addEventListener('input', event => { draft.aiText = (event.target as HTMLTextAreaElement).value; persistQuiet(); });
    host.querySelector('[data-lc-original]')?.addEventListener('click', () => { draft.aiText = undefined; showPreview(); persistQuiet(); });
  }
  function invalidatePhotoDerivedText(): boolean {
    const hadDerived = !!draft.aiText || draft.messages.some(message => message.role === 'assistant');
    draft.aiText = undefined;
    draft.messages = draft.messages.filter(message => message.role === 'user');
    if (hadDerived) {
      showChat(); showPreview();
      status('照片已变化，旧的 AI 提问和整理稿已移除。原话仍保留。');
    }
    return hadDerived;
  }
  async function showPhotos(): Promise<void> {
    const attachments = await Promise.all(draft.existingPhotoRefs.map(id => getAttachment(id)));
    if (disposed) return;
    urls.splice(0).forEach(url => URL.revokeObjectURL(url));
    const pictures = attachments.map((photo, i) => { const url = photo ? URL.createObjectURL(photo.blob) : ''; if (url) urls.push(url); return { url, key: `old:${i}` }; })
      .concat(draft.photos.map((p, i) => ({ url: /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.dataUrl) ? p.dataUrl : '', key: `new:${i}` })));
    host.querySelector('#lc-photos')!.innerHTML = pictures.map((p, i) => `<div>${p.url ? `<img src="${p.url}" alt="照片 ${i + 1}">` : '<span>照片不可用</span>'}<button class="chip" data-lc-remove="${p.key}" aria-label="移除照片 ${i + 1}">移除</button></div>`).join('');
    host.querySelector<HTMLElement>('#lc-image-choice')!.hidden = !pictures.length;
    host.querySelectorAll<HTMLButtonElement>('[data-lc-remove]').forEach(button => { button.disabled = processing; button.onclick = () => {
      const [kind, index] = button.dataset.lcRemove!.split(':');
      if (kind === 'old') draft.existingPhotoRefs.splice(Number(index), 1); else draft.photos.splice(Number(index), 1);
      invalidatePhotoDerivedText(); persistQuiet(); void showPhotos();
    }; });
  }
  async function addPhotos(files: FileList | null): Promise<void> {
    if (!files?.length || processing) return;
    if (files.length + draft.photos.length + draft.existingPhotoRefs.length > 9) { showToast('每条最多 9 张照片'); return; }
    busy(true);
    try {
      const photos: LifeDraft['photos'] = [];
      for (const file of Array.from(files)) { await prepareReceipt(file); photos.push({ name: file.name, dataUrl: await dataUrl(file) }); }
      if (disposed) return;
      draft.photos.push(...photos); const invalidated = invalidatePhotoDerivedText(); await persist(); await showPhotos();
      if (!invalidated) status('照片仅保存在本机草稿中');
    } catch (error) { status(error instanceof Error ? error.message : '照片添加失败'); }
    finally { if (!disposed) busy(false); }
  }
  async function aiAction(mode: 'ask' | 'organize'): Promise<void> {
    if (processing || disposed) return;
    if (draft.aiExcluded) { status('此条已排除 AI。可在“标题与更多”中修改。'); return; }
    if (draft.pendingReply?.trim()) {
      draft.messages.push({ role: 'user', content: draft.pendingReply.trim() }); draft.pendingReply = ''; draft.aiText = undefined;
      host.querySelector<HTMLTextAreaElement>('#lc-reply')!.value = ''; showChat(); showPreview(); persistQuiet();
    }
    if (!draft.body.trim() && !draft.messages.some(m => m.role === 'user') && !host.querySelector<HTMLInputElement>('#lc-send-images')!.checked) { status('先留一句话，或选择让 AI 看照片。'); return; }
    controller = new AbortController(); const signal = controller.signal;
    busy(true);
    try {
      const photos: string[] = [];
      if (host.querySelector<HTMLInputElement>('#lc-send-images')!.checked) {
        for (const id of draft.existingPhotoRefs) { const p = await getAttachment(id); if (p) photos.push(await dataUrl(p.blob)); }
        photos.push(...draft.photos.map(p => p.dataUrl));
      }
      const preview = [draft.body, ...draft.messages.map(m => `${m.role === 'user' ? '我' : 'AI'}：${m.content}`), `照片：${photos.length} 张${photos.length ? '（当前记录中勾选授权的照片）' : '，不发送图片'}`].filter(Boolean).join('\n');
      const expectedDestination = await confirmLifeAi(preview, signal);
      if (!expectedDestination || disposed) return;
      status(mode === 'ask' ? '想一个合适的问题…' : '整理中，原话会保留…');
      const input = { body: draft.body, messages: [...draft.messages], photos, signal, noteId: draft.noteId, sourceUpdatedAt: draft.sourceUpdatedAt, expectedDestination };
      const answer = await (mode === 'ask' ? askLifeQuestion(input) : organizeLifeText(input));
      if (disposed || signal.aborted) return;
      if (mode === 'ask') draft.messages.push({ role: 'assistant', content: answer }); else draft.aiText = answer;
      await persist(); showChat(); showPreview(); status('聊到这里也可以，随时记下。');
    } catch (error) { status(signal.aborted ? '已停止，原话和草稿都还在。' : error instanceof Error ? error.message : 'AI 暂时不可用，可直接记下'); }
    finally { if (!disposed) busy(false); controller = undefined; }
  }
  async function save(): Promise<void> {
    if (saving || processing || disposed) return;
    if (draft.pendingReply?.trim()) { draft.messages.push({ role: 'user', content: draft.pendingReply.trim() }); draft.pendingReply = ''; draft.aiText = undefined; }
    saving = true; busy(true);
    try { await persist(); await saveLifeDraft(draft.key); if (!disposed) closeSheet(); showToast('这一刻，留下了'); }
    catch (error) { saving = false; status(error instanceof Error ? error.message : '未保存，请重试'); if (!disposed) busy(false); }
  }
  async function discard(): Promise<void> {
    if (processing || !await confirmDialog({ title: '丢弃这份草稿？', message: '已保存的记录不会改变。', danger: true })) return;
    clearTimeout(persistTimer);
    try { await queues.get(draft.key)?.catch(() => {}); await deleteLifeDraft(draft.key); unsavedDrafts.delete(draft.key); discarded = true; if (!disposed) closeSheet(); }
    catch { status('草稿未能丢弃，请重试'); }
  }
  async function remove(): Promise<void> {
    if (!existing || processing || !await confirmDialog({ title: '移入回收站？', message: '关联账单不会删除，引用这条记录的周刊将停止展示。', danger: true })) return;
    clearTimeout(persistTimer);
    try { await queues.get(draft.key)?.catch(() => {}); await softDeleteLifeNote(existing.id); await deleteLifeDraft(draft.key); unsavedDrafts.delete(draft.key); discarded = true; if (!disposed) closeSheet(); showToast('已移入回收站'); }
    catch { status('操作未完成，请重试'); }
  }
}

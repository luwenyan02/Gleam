import { esc } from '../../core/esc';
import type { LifeDraft, LifeNote } from '../../core/types';
import { getEntry } from '../../core/repo/entryRepo';
import { getCategory } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { listMerchants } from '../../core/repo/merchantRepo';
import { entryMemoryText } from './entryMemoryText';
import { getAttachment, getLifeNote, softDeleteLifeNote, listLifeLinkedEntries } from '../../core/repo/lifeRepo';
import { formatFenCny } from '../../core/money';
import { claimLegacyLifeChatDraft, getLifeDraft, isLifeChatDraft, putLifeDraft, deleteLifeDraft, saveLifeDraft } from '../../core/repo/lifeDraftRepo';
import { openSheet, closeSheet } from '../shell/sheet';
import { confirmDialog } from '../shell/dialog';
import { showToast } from '../shell/toast';
import { prepareReceipt } from '../entry/receiptEditor';
import { openEntryDetail } from '../detail/entrySwipe';
import { openDateWheel } from '../../shared/dateTimeWheel';
import { openPickList } from '../../shared/pickList';
import { openLifeChat } from './lifeChat';
import './lifeAi.css';

const queues = new Map<string, Promise<void>>();
const unsavedDrafts = new Map<string, LifeDraft>();
let opening = 0;
const dateText = (timestamp: number) => new Date(timestamp).toLocaleDateString('zh-CN');
const MOOD_ITEMS = ['开心', '平静', '充实', '疲惫', '难过'].map(label => ({ value: label, label }));
const VERDICT_ITEMS = [
  { value: 'again', label: '值得再来' },
  { value: 'neutral', label: '一般' },
  { value: 'not-for-me', label: '不太适合我' },
] as const;
const verdictLabel = (value?: string) => VERDICT_ITEMS.find(item => item.value === value)?.label ?? '自己写，不选评价';

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('照片读取失败'));
    reader.readAsDataURL(blob);
  });
}

/** 快速记录与普通记录编辑器：不嵌入或调用生活 AI。 */
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
    let stored = unsavedDrafts.get(key) ?? await getLifeDraft(key);
    if (isLifeChatDraft(stored)) {
      await claimLegacyLifeChatDraft(noteId ? `chat:note:${noteId}` : 'chat:new', [key]);
      await openLifeChat(noteId ? { noteId } : {});
      return;
    }
    let initialBody = existing?.body ?? '';
    // 只初始化首次创建的账单草稿；已有正文或用户主动清空的草稿都保持原样。
    if (!stored && !existing && entry) {
      const [category, accounts, merchants] = await Promise.all([
        entry.categoryId != null ? getCategory(entry.categoryId) : Promise.resolve(undefined),
        listAccounts(true), entry.merchantId != null ? listMerchants() : Promise.resolve([]),
      ]);
      const accountNames = new Map(accounts.map(account => [account.id, account.name]));
      initialBody = entryMemoryText(entry, {
        categoryName: category?.name, merchantName: merchants.find(merchant => merchant.id === entry.merchantId)?.name,
        accountName: accountNames.get(entry.accountId ?? -1),
        fromAccountName: accountNames.get(entry.fromAccountId ?? -1), toAccountName: accountNames.get(entry.toAccountId ?? -1),
      });
    }
    const draft: LifeDraft = stored ?? {
      key, noteId, sourceUpdatedAt: existing?.updatedAt, entryId: options.entryId,
      title: existing?.title ?? '', body: initialBody, occurredAt: existing?.occurredAt ?? entry?.occurredAt ?? Date.now(),
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
  let disposed = false;
  let saving = false;
  let discarded = false;
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
    void pending.finally(() => { if (queues.get(draft.key) === pending) queues.delete(draft.key); });
    return pending;
  };
  const persistQuiet = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { void persist().catch(() => showToast('草稿暂存在当前页面，请勿刷新；可重新打开重试保存')); }, 250);
  };
  const status = (text: string) => { if (!disposed) host.querySelector<HTMLElement>('#lc-status')!.textContent = text; };

  openSheet({
    ariaLabel: existing ? '编辑生活记录' : '快速记录',
    onClose() {
      disposed = true;
      clearTimeout(persistTimer);
      urls.forEach(url => URL.revokeObjectURL(url));
      host.classList.remove('life-composer');
      if (!saving && !discarded) void persist().catch(() => {});
    },
    render(el) {
      host = el;
      el.classList.add('life-composer');
      el.innerHTML = `<div class="lf-sheet-head"><p class="sheet-title">${existing ? '这一刻' : '快速记录'}</p><button class="icon-btn" data-lc-close aria-label="关闭并保留草稿">×</button></div>
        <div class="sheet-scroll lc-scroll">
          ${draft.entryId ? '' : '<p class="sub">一句话、一张照片，都可以。</p>'}
          ${existing?.conversation?.length ? '<button class="btn ghost" data-lc-view-conversation>查看原始对话</button>' : ''}
          <div id="lc-linked-entries"></div>
          <label class="sr-only" for="lc-body">想留下的话</label><textarea id="lc-body" class="note" maxlength="12000" placeholder="刚刚有什么想留住的？">${esc(draft.body)}</textarea>
          <div class="lc-row"><button class="chip" data-lc-photo>＋ 照片</button><button class="chip" data-lc-date>${dateText(draft.occurredAt)}</button></div>
          <input type="file" id="lc-file" accept="image/jpeg,image/png,image/webp" multiple hidden><div class="lc-photos" id="lc-photos"></div>
          <details class="lc-details"><summary>标题与更多</summary>
            <label>标题<input class="note" id="lc-title" maxlength="60" placeholder="可以不填" value="${esc(draft.title)}"></label>
            <label>心情<button class="pick-trigger wide" type="button" id="lc-mood" aria-haspopup="listbox">${esc(draft.mood ?? '不选也可以')}</button></label>
            <label>标签<input class="note" id="lc-tags" placeholder="散步，朋友" value="${esc((draft.tags ?? []).join('，'))}"></label>
            <label class="lc-check"><input type="checkbox" id="lc-exclude" ${draft.aiExcluded ? 'checked' : ''}>不用于 AI 或周刊</label>
          </details>
          <details class="lc-details"><summary>这段经历，后来怎么样</summary>
            <label>现在的感受<button class="pick-trigger wide" type="button" id="lc-verdict" aria-haspopup="listbox">${verdictLabel(draft.review?.verdict)}</button></label>
            <label>补一句<textarea class="note" id="lc-review" maxlength="2000" placeholder="留下了什么，只有你知道">${esc(draft.review?.text ?? '')}</textarea></label>
            <div class="lc-row"><button class="chip" data-lc-revisit>${draft.review?.revisitAt ? `${dateText(draft.review.revisitAt)} 再看看` : '选一天再看看'}</button><button class="chip" data-lc-no-revisit>不提醒</button></div>
          </details>
          <p id="lc-status" class="sub" role="status"></p><button class="btn primary" data-lc-save>就这样记下</button>
          <div class="lc-row lc-footer"><button class="btn ghost" data-lc-discard>丢弃草稿</button>${existing ? '<button class="btn ghost" data-lc-delete>移入回收站</button>' : ''}</div>
        </div>`;
      el.querySelector('[data-lc-close]')!.addEventListener('click', closeSheet);
      el.querySelector<HTMLTextAreaElement>('#lc-body')!.oninput = event => { draft.body = (event.target as HTMLTextAreaElement).value; persistQuiet(); };
      el.querySelector<HTMLInputElement>('#lc-title')!.oninput = event => { draft.title = (event.target as HTMLInputElement).value; persistQuiet(); };
      el.querySelector('#lc-mood')!.addEventListener('click', () => openPickList({
        container: el,
        title: '选择心情',
        items: [{ value: '__none__', label: '不选也可以' }, ...MOOD_ITEMS],
        selected: draft.mood ?? '__none__',
        onPick(value, label) {
          draft.mood = value === '__none__' ? undefined : String(value);
          el.querySelector<HTMLButtonElement>('#lc-mood')!.textContent = label;
          persistQuiet();
        },
      }));
      el.querySelector<HTMLInputElement>('#lc-tags')!.oninput = event => { draft.tags = (event.target as HTMLInputElement).value.split(/[,，]/).map(s => s.trim()).filter(Boolean); persistQuiet(); };
      el.querySelector<HTMLInputElement>('#lc-exclude')!.onchange = event => { draft.aiExcluded = (event.target as HTMLInputElement).checked; persistQuiet(); };
      el.querySelector('#lc-verdict')!.addEventListener('click', () => openPickList({
        container: el,
        title: '选择现在的感受',
        items: [{ value: '__none__', label: '自己写，不选评价' }, ...VERDICT_ITEMS],
        selected: draft.review?.verdict ?? '__none__',
        onPick(value, label) {
          draft.review = { ...draft.review, verdict: value === '__none__' ? undefined : value as NonNullable<LifeDraft['review']>['verdict'] };
          el.querySelector<HTMLButtonElement>('#lc-verdict')!.textContent = label;
          persistQuiet();
        },
      }));
      el.querySelector<HTMLTextAreaElement>('#lc-review')!.oninput = event => { draft.review = { ...draft.review, text: (event.target as HTMLTextAreaElement).value }; persistQuiet(); };
      el.querySelector('[data-lc-date]')!.addEventListener('click', () => pickDate(draft.occurredAt, value => { draft.occurredAt = value; el.querySelector('[data-lc-date]')!.textContent = dateText(value); persistQuiet(); }));
      el.querySelector('[data-lc-revisit]')!.addEventListener('click', () => pickDate(draft.review?.revisitAt ?? Date.now() + 7 * 86400000, value => { draft.review = { ...draft.review, revisitAt: value, dismissedAt: undefined }; el.querySelector('[data-lc-revisit]')!.textContent = `${dateText(value)} 再看看`; persistQuiet(); }));
      el.querySelector('[data-lc-no-revisit]')!.addEventListener('click', () => { draft.review = { ...draft.review, revisitAt: undefined, dismissedAt: Date.now() }; el.querySelector('[data-lc-revisit]')!.textContent = '选一天再看看'; persistQuiet(); });
      el.querySelector('[data-lc-photo]')!.addEventListener('click', () => el.querySelector<HTMLInputElement>('#lc-file')!.click());
      el.querySelector<HTMLInputElement>('#lc-file')!.onchange = event => { void addPhotos((event.target as HTMLInputElement).files); };
      el.querySelector('[data-lc-view-conversation]')?.addEventListener('click', async () => { await persist(); if (!disposed) { closeSheet(); void openLifeChat({ noteId: existing!.id }); } });
      el.querySelector('[data-lc-save]')!.addEventListener('click', () => { void save(); });
      el.querySelector('[data-lc-discard]')!.addEventListener('click', () => { void discard(); });
      el.querySelector('[data-lc-delete]')?.addEventListener('click', () => { void remove(); });
      void showPhotos().catch(() => status('照片暂时无法读取'));
      void showLinked().catch(() => status('关联账单暂时无法读取'));
    },
  });

  function pickDate(timestamp: number, accept: (timestamp: number) => void): void {
    const d = new Date(timestamp);
    document.body.appendChild(openDateWheel({ initial: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }, onConfirm: r => accept(new Date(r.year, r.month - 1, r.day, 12).getTime()) }));
  }
  async function showLinked(): Promise<void> {
    if (!draft.noteId) return;
    const entries = await listLifeLinkedEntries(draft.noteId);
    if (disposed) return;
    host.querySelector('#lc-linked-entries')!.innerHTML = entries.length ? `<details class="lc-details"><summary>关联原账单 · ${entries.length} 笔</summary>${entries.map(e => `<button class="btn ghost" data-lc-entry="${e.id}">${dateText(e.occurredAt)} · ${e.refundFlag ? '退款' : e.type === 'expense' ? '支出' : e.type === 'income' ? '收入' : '资金往来'} ${formatFenCny(e.amount)} ›</button>`).join('')}</details>` : '';
    host.querySelectorAll<HTMLButtonElement>('[data-lc-entry]').forEach(button => { button.onclick = async () => {
      try {
        await persist(); if (disposed) return; closeSheet();
        openEntryDetail(Number(button.dataset.lcEntry));
      } catch { showToast('暂时无法打开账单，草稿已保留'); }
    }; });
  }
  async function showPhotos(): Promise<void> {
    const attachments = await Promise.all(draft.existingPhotoRefs.map(id => getAttachment(id)));
    if (disposed) return;
    urls.splice(0).forEach(url => URL.revokeObjectURL(url));
    const pictures = attachments.map((photo, i) => { const url = photo ? URL.createObjectURL(photo.blob) : ''; if (url) urls.push(url); return { url, key: `old:${i}` }; }).concat(draft.photos.map((p, i) => ({ url: p.dataUrl, key: `new:${i}` })));
    host.querySelector('#lc-photos')!.innerHTML = pictures.map((p, i) => `<div>${p.url ? `<img src="${p.url}" alt="照片 ${i + 1}">` : '<span>照片不可用</span>'}<button class="chip" data-lc-remove="${p.key}" aria-label="移除照片 ${i + 1}">移除</button></div>`).join('');
    host.querySelectorAll<HTMLButtonElement>('[data-lc-remove]').forEach(button => button.onclick = () => { const [kind, index] = button.dataset.lcRemove!.split(':'); if (kind === 'old') draft.existingPhotoRefs.splice(Number(index), 1); else draft.photos.splice(Number(index), 1); persistQuiet(); void showPhotos(); });
  }
  async function addPhotos(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    if (files.length + draft.photos.length + draft.existingPhotoRefs.length > 9) { showToast('每条最多 9 张照片'); return; }
    try { for (const file of Array.from(files)) { await prepareReceipt(file); draft.photos.push({ name: file.name, dataUrl: await dataUrl(file) }); } await persist(); await showPhotos(); }
    catch (error) { status(error instanceof Error ? error.message : '照片添加失败'); }
  }
  async function save(): Promise<void> {
    if (saving || disposed) return;
    saving = true;
    try { await persist(); await saveLifeDraft(draft.key); if (!disposed) { closeSheet(); showToast('这一刻，留下了'); } }
    catch (error) { saving = false; status(error instanceof Error ? error.message : '未保存，请重试'); }
  }
  async function discard(): Promise<void> {
    if (!await confirmDialog({ title: '丢弃这份草稿？', message: '已保存的记录不会改变。', danger: true })) return;
    try { await queues.get(draft.key)?.catch(() => {}); await deleteLifeDraft(draft.key); unsavedDrafts.delete(draft.key); discarded = true; if (!disposed) closeSheet(); }
    catch { status('草稿未能丢弃，请重试'); }
  }
  async function remove(): Promise<void> {
    if (!existing || !await confirmDialog({ title: '移入回收站？', message: '关联账单不会删除，引用这条记录的周刊将停止展示。', danger: true })) return;
    try { await softDeleteLifeNote(existing.id); await deleteLifeDraft(draft.key); unsavedDrafts.delete(draft.key); discarded = true; if (!disposed) { closeSheet(); showToast('已移入回收站'); } }
    catch { status('操作未完成，请重试'); }
  }
}

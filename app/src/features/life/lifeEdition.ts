import { esc } from '../../core/esc';
import type { LifeNote } from '../../core/types';
import { previousLifeWeek, shiftLifeWeek } from '../../core/lifeWeek';
import { getLifeEdition, getLifeWeekSources, saveLifeEdition, deleteLifeEdition, type LifeEditionInput } from '../../core/repo/lifeEditionRepo';
import { generateLifeEdition } from '../../core/repo/lifeAiRepo';
import { getAttachment } from '../../core/repo/lifeRepo';
import { getSetting } from '../../core/repo/settingsRepo';
import { on } from '../../core/store';
import { registerSubpage, openSubpage } from '../shell/router';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';
import { confirmLifeAi } from './lifeAiConsent';
import { openLifeComposer } from './lifeComposer';
import './lifeAi.css';

export function openLifeEdition(): void { openSubpage('sp-life-edition'); }
export function initLifeEdition(): void {
  registerSubpage('sp-life-edition', { title: '拾光周刊', render: renderEdition });
}

async function renderEdition(body: HTMLElement): Promise<void> {
  const page = body.closest<HTMLElement>('.subpage')!;
  body.classList.add('life-edition-body');
  let week = previousLifeWeek();
  let sources: LifeNote[] = [];
  let draft: LifeEditionInput | undefined;
  let archived = false, busy = false, closed = false, loadVersion = 0;
  let selected = new Set<number>();
  let controller: AbortController | undefined;
  let coverUrl = '';
  const off = on('settings-changed', () => { void getSetting('life.aiEnabled').then(enabled => { if (!enabled) controller?.abort(); }); });
  const offLife = on('life-changed', () => { if (!closed) { controller?.abort(); void load(); } });
  let opened = page.classList.contains('open');
  const observer = new MutationObserver(() => {
    if (page.classList.contains('open')) opened = true;
    // 弹层隔离也会设置 aria-hidden，只有路由退场才意味着关闭。
    if ((opened && !page.classList.contains('open')) || !page.isConnected) {
      if (closed) return;
      closed = true; controller?.abort(); off(); offLife(); observer.disconnect(); if (coverUrl) URL.revokeObjectURL(coverUrl);
    }
  });
  observer.observe(page, { attributes: true, attributeFilter: ['class'] });
  body.innerHTML = `<div class="le-week-nav"><button class="icon-btn" data-le-prev aria-label="上一周">‹</button><strong id="le-week"></strong><button class="icon-btn" data-le-next aria-label="下一周">›</button></div>
    <p class="le-hint">随手留下的，也值得收藏。素材只在你同意后交给 AI。</p>
    <div id="le-content"></div><p id="le-status" class="le-hint" role="status"></p>`;
  const content = body.querySelector<HTMLElement>('#le-content')!;
  const status = (text: string) => { if (!closed) body.querySelector('#le-status')!.textContent = text; };
  const setBusy = (value: boolean) => {
    busy = value;
    body.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select,button').forEach(el => { if (!el.matches('[data-le-stop]')) el.disabled = value; });
    body.querySelector<HTMLElement>('[data-le-stop]')?.toggleAttribute('hidden', !value);
    if (!value) body.querySelector<HTMLButtonElement>('[data-le-next]')!.disabled = week.key === previousLifeWeek().key;
  };
  async function load(): Promise<void> {
    const version = ++loadVersion;
    try {
      const [notes, saved] = await Promise.all([getLifeWeekSources(week.key), getLifeEdition(week.key)]);
      if (closed || version !== loadVersion) return;
      sources = notes; selected = new Set(notes.map(note => note.id));
      body.querySelector('#le-week')!.textContent = week.label;
      body.querySelector<HTMLButtonElement>('[data-le-next]')!.disabled = week.key === previousLifeWeek().key;
      archived = !!saved;
      if (saved?.status === 'blocked') {
        draft = undefined;
        content.innerHTML = `<div class="card le-empty"><h3>这期暂不展示</h3><p class="le-hint">部分素材已删除或被排除。旧标题、正文和封面已隐藏。</p><button class="btn ghost" data-le-delete>清理这一期</button></div>`;
      } else if (saved) {
        draft = saved.edition; await renderPaper(saved.status === 'stale' ? '原记录有更新。这是收藏时的版本，不会自动覆盖；可清理后重新选择素材。' : '已收藏 · 保留这一周的片段');
      } else { draft = undefined; renderSources(); }
      status('');
    } catch (error) { status(error instanceof Error ? error.message : '周刊暂时无法读取'); }
  }
  function renderSources(): void {
    content.innerHTML = sources.length ? `<section class="card le-source-list" aria-label="选择周刊素材">${sources.map(note => `<label class="le-source"><input type="checkbox" data-le-source="${note.id}" ${selected.has(note.id) ? 'checked' : ''}><span>${esc(note.title || '一个生活片段')}<small>${new Date(note.occurredAt).toLocaleDateString('zh-CN')} · ${esc((note.body ?? '').slice(0,180))}${note.photoRefs?.length ? ` · ${note.photoRefs.length} 张照片` : ''}</small></span></label>`).join('')}</section>
      <p class="le-hint">仅发送选中记录的文字与日期，不发送照片、账单和账户信息。照片可在本地选作封面。</p>
      <button class="btn primary" data-le-generate>做成这一周的小报</button><button class="btn ghost" data-le-stop hidden>停止生成</button>`
      : '<section class="card le-empty"><h3>这一周，留白也很好</h3><p class="le-hint">有片段时再来，不用补写。</p></section>';
  }
  async function renderPaper(hint = '预览 · 每个片段都来自你选中的记录'): Promise<void> {
    if (!draft || closed) return;
    if (coverUrl) { URL.revokeObjectURL(coverUrl); coverUrl = ''; }
    const covers = sources.filter(note => draft!.sourceRefs.some(ref => ref.noteId === note.id)).flatMap(note => (note.photoRefs ?? []).map(id => ({ id, name: note.title || '生活照片' })));
    if (draft.coverAttachmentId != null) {
      const attachment = await getAttachment(draft.coverAttachmentId);
      if (closed) return;
      if (attachment) coverUrl = URL.createObjectURL(attachment.blob);
    }
    const readonly = archived;
    content.innerHTML = `<p class="le-hint">${esc(hint)}</p><article class="card le-paper"><p class="le-kicker">拾光周刊 · ${draft.blocks.length === 1 ? '一张小卡' : '生活的点点滴滴'}</p>
      ${readonly ? `<h2 class="le-title">${esc(draft.title)}</h2>` : `<label class="sr-only" for="le-title">周刊标题</label><input class="note le-title" id="le-title" maxlength="100" value="${esc(draft.title)}">`}
      ${coverUrl ? `<img class="le-cover" src="${coverUrl}" alt="自己选择的本周封面">` : ''}
      ${!readonly && covers.length ? `<label class="le-cover-choice">本地封面<select id="le-cover"><option value="">不放封面</option>${covers.map((c,i) => `<option value="${c.id}" ${c.id === draft!.coverAttachmentId ? 'selected' : ''}>照片 ${i+1} · ${esc(c.name)}</option>`).join('')}</select></label>` : ''}
      ${draft.blocks.map((block, index) => `<section class="le-block">${readonly ? `<p>${esc(block.text)}</p>` : `<label class="sr-only" for="le-block-${index}">片段 ${index + 1}</label><textarea class="note" id="le-block-${index}" data-le-text="${index}" maxlength="2000">${esc(block.text)}</textarea>`}<div class="lc-row"><button class="chip" data-le-view="${block.noteId}">回到原记录</button>${!readonly ? `<button class="chip" data-le-remove="${index}">不收录这段</button>` : ''}</div></section>`).join('')}
      </article><div class="lc-row">${readonly ? '<button class="btn ghost" data-le-edit>编辑这一期</button><button class="btn ghost" data-le-delete>清理这一期</button>' : '<button class="btn primary" data-le-save>收藏这一期</button><button class="btn ghost" data-le-reselect>重新选素材</button>'}</div>`;
  }
  async function generate(): Promise<void> {
    if (busy || !selected.size) { if (!selected.size) status('选一个想留下的片段就好。'); return; }
    controller = new AbortController(); const signal = controller.signal;
    setBusy(true);
    try {
      const notes = sources.filter(note => selected.has(note.id));
      const preview = `${week.label}\n${notes.map(n => `${new Date(n.occurredAt).toLocaleDateString('zh-CN')} · ${n.title || '生活片段'}\n${n.body || '（无正文）'}${n.review?.text ? `\n后续感受：${n.review.text}` : ''}${n.review?.verdict ? `\n评价：${n.review.verdict}` : ''}`).join('\n\n')}\n照片不发送，账单不发送。`;
      const expectedDestination = await confirmLifeAi(preview, signal);
      if (!expectedDestination || closed) return;
      status('把零散的小事，慢慢串起来…');
      const result = await generateLifeEdition({ weekKey: week.key, noteIds: [...selected], sourceRefs: notes.map(n => ({ noteId: n.id, updatedAt: n.updatedAt })), signal, expectedDestination });
      if (closed || signal.aborted) return;
      draft = result; archived = false; await renderPaper(); status('可修改标题、片段或选择本地封面，再收藏。');
    } catch (error) { status(signal.aborted ? '已停止，没有保存生成结果。' : error instanceof Error ? error.message : '生成失败，可以稍后再来'); }
    finally { controller = undefined; if (!closed) setBusy(false); }
  }
  async function act(action: string, target: HTMLElement): Promise<void> {
    if (action === 'stop') { controller?.abort(); return; }
    if (busy) return;
    try {
      if (action === 'prev' || action === 'next') { week = shiftLifeWeek(week.key, action === 'prev' ? -1 : 1); await load(); }
      else if (action === 'generate') await generate();
      else if (action === 'view') await openLifeComposer({ noteId: Number(target.dataset.leView) });
      else if (action === 'remove' && draft) { draft.blocks.splice(Number(target.dataset.leRemove),1); await renderPaper(); }
      else if (action === 'edit' && draft) { archived = false; await renderPaper('编辑收藏稿 · 保存前会再次核对素材'); }
      else if (action === 'reselect') { draft = undefined; renderSources(); }
      else if (action === 'delete') {
        if (!await confirmDialog({ title: '清理这一期？', message: '只删除周刊，原始生活记录和照片保持不变。', danger: true })) return;
        await deleteLifeEdition(week.key); await load();
      } else if (action === 'save' && draft) {
        if (!draft.blocks.length) { status('至少保留一个片段，或返回重新选择。'); return; }
        const existing = await getLifeEdition(week.key);
        if (existing && !await confirmDialog({ title: '替换已收藏的这一期？', message: '原始记录不变，周刊将保存为当前预览。' })) return;
        setBusy(true);
        try { await saveLifeEdition(draft, { overwrite: !!existing }); await load(); showToast('这一周，收好了'); }
        finally { if (!closed) setBusy(false); }
      }
    } catch (error) { status(error instanceof Error ? error.message : '操作未完成，请重试'); }
  }
  body.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('button');
    if (!button) return;
    const action = ['prev','next','generate','view','remove','edit','reselect','delete','save','stop'].find(name => button.hasAttribute(`data-le-${name}`));
    if (action) void act(action, button);
  });
  body.addEventListener('change', event => {
    const el = event.target as HTMLInputElement;
    if (el.dataset.leSource) { const id = Number(el.dataset.leSource); if (el.checked) selected.add(id); else selected.delete(id); }
    if (el.id === 'le-cover' && draft) { draft.coverAttachmentId = el.value ? Number(el.value) : undefined; void renderPaper(); }
  });
  body.addEventListener('input', event => {
    const el = event.target as HTMLInputElement;
    if (!draft) return;
    if (el.id === 'le-title') draft.title = el.value;
    if (el.dataset.leText != null) draft.blocks[Number(el.dataset.leText)]!.text = el.value;
  });
  await load();
}

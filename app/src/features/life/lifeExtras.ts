import { esc } from '../../core/esc';
import { iconHtml } from '../../assets/icons';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { listLifeNotes, updateLifeNote, linkEntryToLifeNote } from '../../core/repo/lifeRepo';
import { getEntry } from '../../core/repo/entryRepo';
import { openLifeComposer } from './lifeComposer';
import { openSheet, closeSheet } from '../shell/sheet';
import { openPickList } from '../../shared/pickList';
import { showToast } from '../shell/toast';
import { openSubpage } from '../shell/router';
import { confirmDialog } from '../shell/dialog';

export async function openLifeAiControls(): Promise<void> {
  const enabled = await getSetting('life.aiEnabled');
  openSheet({ ariaLabel: '生活 AI 与隐私', render(el) {
    el.innerHTML = `<div class="lf-sheet-head"><p class="sheet-title">AI 与隐私</p><button class="icon-btn" data-life-close aria-label="关闭">×</button></div><div class="sheet-scroll life-ai-controls">
      <label class="life-ai-toggle"><span>启用生活 AI</span><input type="checkbox" role="switch" id="life-ai-enabled" ${enabled ? 'checked' : ''}></label>
      <div class="life-ai-privacy">
        <div class="life-ai-privacy-copy">
          <p>记录默认留在本机。关闭 AI 仍可记录、阅读已收藏周刊。</p>
          <p>聊天与附件点击发送后、语音连接后，会传给你配置的 AI 服务。</p>
          <p>整理、生成周刊和分析账本，需先确认内容。</p>
        </div>
        <details><summary>更多隐私说明</summary><p>单条记录可在「标题与更多」中排除。周刊可单独清理，不会自动生成，也不发送照片和账单。</p></details>
      </div>
      <button class="life-ai-settings" data-life-ai-config><span>AI 接口设置</span>${iconHtml('ic-right', 18)}</button></div>`;
    el.querySelector('[data-life-close]')!.addEventListener('click', closeSheet);
    el.querySelector('[data-life-ai-config]')!.addEventListener('click', () => { closeSheet(); openSubpage('sp-settings'); });
    el.querySelector<HTMLInputElement>('#life-ai-enabled')!.onchange = async event => {
      const checkbox = event.target as HTMLInputElement;
      const hadFocus = document.activeElement === checkbox;
      checkbox.disabled = true;
      try { await setSetting('life.aiEnabled', checkbox.checked); showToast(checkbox.checked ? '已启用生活 AI' : '已关闭生活 AI'); }
      catch { checkbox.checked = !checkbox.checked; showToast('设置未保存，请重试'); }
      finally {
        checkbox.disabled = false;
        if (hadFocus && checkbox.isConnected && !el.inert
          && (document.activeElement === document.body || document.activeElement === el)) checkbox.focus({ preventScroll: true });
      }
    };
  } });
}

export async function renderLifeRevisits(host: HTMLElement, show: boolean, isCurrent = () => true): Promise<void> {
  if (!show) { host.innerHTML = ''; return; }
  const now = Date.now();
  const notes = (await listLifeNotes()).filter(note => note.review?.revisitAt && note.review.revisitAt <= now && !note.review.dismissedAt).slice(0, 3);
  if (!host.isConnected || !isCurrent()) return;
  host.innerHTML = notes.map(note => `<section class="card life-revisit"><p>这段经历，后来怎么样？</p><p class="sub">${esc(note.title || (note.originalBody ?? note.body)?.slice(0,60) || '一个生活片段')}</p><div class="lc-row"><button class="chip" data-revisit="${note.id}">补一句感受</button><button class="chip" data-revisit-later="${note.id}">一周后</button><button class="chip" data-revisit-dismiss="${note.id}">不再提醒</button></div></section>`).join('');
  host.querySelectorAll<HTMLButtonElement>('[data-revisit]').forEach(button => button.onclick = () => { void openLifeComposer({ noteId: Number(button.dataset.revisit) }); });
  for (const action of ['later', 'dismiss'] as const) host.querySelectorAll<HTMLButtonElement>(`[data-revisit-${action}]`).forEach(button => { button.onclick = async () => {
    const note = notes.find(note => note.id === Number(button.getAttribute(`data-revisit-${action}`)));
    if (!note) return; button.disabled = true;
    try { await updateLifeNote(note.id, { review: { ...note.review, ...(action === 'later' ? { revisitAt: now + 7 * 86400000 } : { dismissedAt: now }) } }); }
    catch { showToast('暂未保存，请重试'); button.disabled = false; }
  }; });
}

export async function openEntryLifeStory(entryId: number, container: HTMLElement): Promise<void> {
  try {
    const entry = await getEntry(entryId);
    if (!entry || entry.deletedAt) throw new Error('这笔账单已不在当前账本中');
    const notes = (await listLifeNotes()).filter(note => note.kind !== 'habit');
    if (entry.lifeNoteId && notes.some(note => note.id === entry.lifeNoteId)) { await openLifeComposer({ entryId }); return; }
    if (!notes.length) { await openLifeComposer({ entryId }); return; }
    openPickList({ container, title: '这一笔，也有故事？', searchable: true,
      items: [{ value: 'new', label: '留一个新故事', group: '新记录' }, ...notes.map(note => ({ value: note.id, label: note.title || note.body?.slice(0,60) || '照片记录', note: new Date(note.occurredAt).toLocaleDateString('zh-CN'), group: '关联已有记录' }))],
      onPick: value => { if (value === 'new') { void openLifeComposer({ entryId }); return; }
        void (async () => {
          if (!await confirmDialog({ title: '把这笔账关联到已有故事？', message: '不会改变金额、原文或其他账单。' })) return;
          await linkEntryToLifeNote(entryId, Number(value)); showToast('账单与故事已关联');
        })().catch(error => showToast(error instanceof Error ? error.message : '关联未完成'));
      },
    });
  } catch (error) { showToast(error instanceof Error ? error.message : '故事暂时打不开'); }
}

/**
 * 拾光 · 生活记录（features/life，PRD 4.14）
 * 一级页 page-life：日记、照片记录和习惯打卡统一按时间排序；照片 Blob 的 object URL
 * 统一回收。按月浏览；非空态使用右下角 #fab-life，空态只保留一个主操作。
 * 打卡时 checkHabit + addLifeNote 双写：打卡记录同时进首页时间线混排；
 * kind='habit' 的打卡记录用于重建连续天数，时间流由可操作的习惯卡呈现，避免重复展示。
 * 视觉结构与原型 index.html #page-life（L611-677）一致；数据一律经 lifeRepo。
 */
import './life.css';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { on } from '../../core/store';
import { formatFen, parseYuanToFen } from '../../core/money';
import { dayKey } from '../../core/repo/entryRepo';
import { ledgerEntriesInRange } from '../../core/repo/statsRepo';
import { getSetting } from '../../core/repo/settingsRepo';
import { summarizeLedgerEntries } from '../../core/ledgerQuery';
import {
  addAttachment, addHabit, addLifeNote, checkHabit, deleteHabit, getAttachment,
  habitStreak, isCheckedToday, listHabits, listLifeNotes, renameHabit,
  softDeleteLifeNote, purgeLifeNote, uncheckHabit, updateLifeNote, type NewLifeNote,
} from '../../core/repo/lifeRepo';
import { registerPage } from '../shell/router';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';
import type { Habit, LifeNote } from '../../core/types';
import { openLifeComposer } from './lifeComposer';
import { initLifeChat, openLifeChat } from './lifeChat';
import { initLifeEdition, openLifeEdition } from './lifeEdition';
import { openLifeAiControls, renderLifeRevisits } from './lifeExtras';
import './lifeAi.css';

/** 抽屉监听器控制：#sheet 为复用容器，重开前必须废止上一次绑定 */
let sheetAbort: AbortController | undefined;

function sheetSignal(): AbortSignal {
  sheetAbort?.abort();
  sheetAbort = new AbortController();
  return sheetAbort.signal;
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const MOODS = ['开心', '平静', '充实', '疲惫', '难过'];

/** 卡片日期行：今天 · 8月7日 / 8月6日 · 周四 */
function lnDate(ts: number): string {
  const d = new Date(ts);
  const label = `${d.getMonth() + 1}月${d.getDate()}日`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (ts >= today.getTime()) return `今天 · ${label}`;
  if (ts >= today.getTime() - 86400000) return `昨天 · ${label}`;
  return `${label} · 周${WEEK[d.getDay()]}`;
}

function hm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ── 页面状态（一级页常驻 DOM，模块级持有） ── */
let root: HTMLElement | undefined;
/** 浏览月份（当月 1 日 0 点） */
let viewMonth = startOfMonth(Date.now());
/** 本轮渲染创建的照片 object URL（下一轮渲染前统一 revoke） */
let photoUrls: string[] = [];
/** 最近一次渲染的记录 / 习惯（点击回取） */
let notes: LifeNote[] = [];
let habits: Habit[] = [];
let refreshVersion = 0;

function startOfMonth(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function endOfMonth(monthStart: number): number {
  const d = new Date(monthStart);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1;
}

/** 注册生活一级页（覆盖 page-life 占位），main.ts 调用一次 */
export function initLife(): void {
  initLifeEdition();
  initLifeChat();
  // 右下角悬浮「+」（shell 挂载，mountShell 先于本函数）：直接绑定，
  // shell 不感知 life 模块；节点常驻，一次绑定永久有效
  document.getElementById('fab-life')?.addEventListener('click', () => openTypeSheet());

  registerPage('page-life', {
    render(el) {
      root = el;
      el.innerHTML = `
        <header class="page-head">
          <div>
            <h2 class="brand sm">生活</h2>
            <p class="sub" id="lf-sub"></p>
          </div>
          <div style="display:flex;gap:8px">
            <button class="icon-btn" id="lf-prev" aria-label="查看上一月">${iconHtml('ic-left')}</button>
            <button class="icon-btn" id="lf-next" aria-label="查看下一月" hidden>${iconHtml('ic-right')}</button>
          </div>
        </header>
        <div class="life-intro"><p>拾起生活的点点滴滴</p></div>
        <div class="life-tools"><button class="chip" data-life-capture>快速记录</button><button class="chip life-chat-entry" data-life-chat>和拾光聊聊</button><button class="chip" data-life-edition>拾光周刊</button><button class="chip" data-life-ai-controls>AI 与隐私</button></div>
        <div id="lf-revisits"></div>
        <p class="sub" id="lf-today-sum" style="padding:0 4px 12px"></p>
        <div id="lf-feed"></div>`;

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-life-capture]')) { void openLifeComposer(); return; }
        if (target.closest('[data-life-chat]')) { void openLifeChat(); return; }
        if (target.closest('[data-life-edition]')) { openLifeEdition(); return; }
        if (target.closest('[data-life-ai-controls]')) { void openLifeAiControls(); return; }
        if (target.closest('#lf-prev')) { shiftMonth(-1); return; }
        if (target.closest('#lf-next')) { shiftMonth(1); return; }
        if (target.closest('#lf-empty')) { openTypeSheet(); return; }
        const check = target.closest<HTMLElement>('[data-check]');
        if (check) {
          const habit = habits.find((h) => h.id === Number(check.dataset.check));
          if (habit) void toggleCheck(habit);
          return;
        }
        const habitCard = target.closest<HTMLElement>('[data-habit]');
        if (habitCard) {
          const habit = habits.find((h) => h.id === Number(habitCard.dataset.habit));
          if (habit) openHabitEdit(habit);
          return;
        }
        const noteCard = target.closest<HTMLElement>('[data-note]');
        if (noteCard) {
          const note = notes.find((n) => n.id === Number(noteCard.dataset.note));
          if (note?.kind === 'habit') {
            const habit = habits.find(h => h.id === note.habitId);
            if (habit) openHabitEdit(habit);
          } else if (note) void openLifeComposer({ noteId: note.id });
        }
      });
      el.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const actionable = (event.target as HTMLElement).closest<HTMLElement>('[data-note], [data-habit], #lf-empty');
        if (!actionable || event.target instanceof HTMLButtonElement) return;
        event.preventDefault();
        actionable.click();
      });
    },
    onShow() { void refresh(); },
  });

  // 记录/账单变化时刷新（一级页常驻，不退订，与 home 同策略）
  for (const ev of ['life-changed', 'entries-changed'] as const) {
    on(ev, () => { if (root?.isConnected) void refresh(); });
  }
}

function shiftMonth(delta: number): void {
  const d = new Date(viewMonth);
  viewMonth = new Date(d.getFullYear(), d.getMonth() + delta, 1).getTime();
  if (viewMonth > startOfMonth(Date.now())) viewMonth = startOfMonth(Date.now());
  void refresh();
}

/** 搜索命中生活记录时定位：切到记录所在月份，刷新后滚动到该卡片并短暂高亮。 */
export function focusLifeRecord(noteId: number, occurredAt: number): void {
  viewMonth = startOfMonth(occurredAt);
  void refresh().then(() => {
    const card = root?.querySelector<HTMLElement>(`[data-note="${noteId}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('lf-focus');
    setTimeout(() => card.classList.remove('lf-focus'), 1600);
  });
}

async function refresh(): Promise<void> {
  const version = ++refreshVersion;
  const el = root;
  if (!el?.isConnected) return;
  const isCurrent = viewMonth === startOfMonth(Date.now());
  const from = viewMonth;
  const to = endOfMonth(viewMonth);

  const [monthNotes, habitList] = await Promise.all([listLifeNotes({ from, to }), listHabits()]);
  if (!el.isConnected || version !== refreshVersion) return;
  habits = habitList;
  notes = monthNotes.filter(n => n.kind !== 'habit' || !isCurrent
    || dayKey(n.occurredAt) !== dayKey(Date.now()) || !habits.some(h => h.id === n.habitId));

  el.querySelector('#lf-sub')!.textContent = `${new Date(viewMonth).getFullYear()}年 ${new Date(viewMonth).getMonth() + 1}月`;
  await renderLifeRevisits(el.querySelector<HTMLElement>('#lf-revisits')!, isCurrent, () => version === refreshVersion);
  if (!el.isConnected || version !== refreshVersion) return;
  el.querySelector<HTMLElement>('#lf-next')!.hidden = isCurrent;

  /* 今日支出摘要（仅当月视图） */
  const sumEl = el.querySelector<HTMLElement>('#lf-today-sum')!;
  if (isCurrent) {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    const countAsIncome = await getSetting('reimburse.countAsIncome');
    const todays = (await ledgerEntriesInRange(dayStart.getTime(), dayEnd.getTime(), countAsIncome))
      .filter((entry) => entry.type === 'expense');
    if (!el.isConnected || version !== refreshVersion) return;
    const total = summarizeLedgerEntries(todays, {
      reimburseMode: countAsIncome ? 'income' : 'offset',
    }).expense;
    sumEl.hidden = false;
    sumEl.textContent = todays.length ? `今天共花了 ¥${formatFen(total)} · ${todays.length} 笔` : '今天还没有支出 · 记一笔会显示在这里';
  } else {
    sumEl.hidden = true;
  }

  /* 习惯、日记、照片统一进入同一个时间流。 */
  const streaks = await Promise.all(habits.map(h => habitStreak(h.id)));
  if (!el.isConnected || version !== refreshVersion) return;
  const habitItems: { at: number; html: string }[] = [];
  if (isCurrent && habits.length) {
    const dotFrom = new Date(); dotFrom.setHours(0, 0, 0, 0);
    dotFrom.setDate(dotFrom.getDate() - 6);
    const habitNotes = await listLifeNotes({ kind: 'habit', from: dotFrom.getTime() });
    if (!el.isConnected || version !== refreshVersion) return;
    const cards = await Promise.all(habits.map(async (h, i) => {
      const checkedDays = new Set(habitNotes.filter((n) => n.habitId === h.id).map((n) => dayKey(n.occurredAt)));
      const todayNote = habitNotes.find((n) => n.habitId === h.id && dayKey(n.occurredAt) === dayKey(Date.now()));
      const checked = await isCheckedToday(h.id);
      const dots = Array.from({ length: 7 }, (_, k) => {
        const d = new Date(dotFrom.getTime()); d.setDate(d.getDate() + k);
        return `<span${checkedDays.has(dayKey(d.getTime())) ? ' class="done"' : ''}></span>`;
      }).join('');
      return { at: todayNote?.occurredAt ?? Date.now() - i, html: `
        <section class="card habit" data-habit="${h.id}" role="button" tabindex="0" aria-label="习惯：${esc(h.name)}">
          <span class="e-ic life">${iconHtml('ic-pulse')}</span>
          <div>
            <p class="e-title">${esc(h.name)}</p>
            <p class="e-meta">已连续 ${streaks[i]} 天 · ${checked ? `今天 ${todayNote ? hm(todayNote.occurredAt) : ''} 完成` : '今天还没打卡'}</p>
          </div>
          <div class="streak" aria-label="近 7 天打卡">${dots}</div>
          <button class="lf-check${checked ? ' on' : ''}" data-check="${h.id}">${checked ? '已打卡' : '打卡'}</button>
        </section>` };
    }));
    if (!el.isConnected || version !== refreshVersion) return;
    habitItems.push(...cards);
  }

  /* 时间线（日记 + 照片 + 习惯） */
  const feed = el.querySelector<HTMLElement>('#lf-feed')!;
  const nextPhotoUrls: string[] = [];
  const noteItems = await Promise.all(notes.map(async (n) => {
    if (n.kind === 'habit') {
      const exists = habits.some(h => h.id === n.habitId);
      return {at:n.occurredAt, html:`<article class="card habit-history" data-note="${n.id}"${exists ? ' role="button" tabindex="0"' : ''}>
        <p class="ln-date">${lnDate(n.occurredAt)} · ${hm(n.occurredAt)}</p>
        <h3 class="ln-title">${esc(n.title ?? '习惯打卡')}</h3><p class="sub">已完成打卡</p></article>`};
    }
    if (n.kind === 'photo' || n.photoRefs?.length) {
      const photos = await Promise.all((n.photoRefs ?? []).map((id) => getAttachment(id)));
      const imgs = photos.filter((p) => !!p).map((p) => {
        const url = URL.createObjectURL(p.blob);
        nextPhotoUrls.push(url);
        return `<img class="photo" src="${url}" alt="${esc(p.name ?? '照片')}">`;
      }).join('');
      return { at: n.occurredAt, html: `
        <article class="card" data-note="${n.id}" role="button" tabindex="0">
          <p class="ln-date">${lnDate(n.occurredAt)}</p>
          ${n.title ? `<h3 class="ln-title">${esc(n.title)}</h3>` : ''}
          <div class="photo-row">${imgs}</div>
          ${n.body ? `<p class="ln-body sm">${esc(n.body)}</p>` : ''}
        </article>` };
    }
    const tags = [
      n.mood ? `<span class="chip tag">心情 · ${esc(n.mood)}</span>` : '',
      ...(n.tags ?? []).map((t) => `<span class="chip tag">${esc(t)}</span>`),
      n.linkedAmount ? `<span class="chip tag num">关联支出 ¥${formatFen(n.linkedAmount)}</span>` : '',
    ].join('');
    return { at: n.occurredAt, html: `
      <article class="card" data-note="${n.id}" role="button" tabindex="0">
        <p class="ln-date">${lnDate(n.occurredAt)}</p>
        ${n.title ? `<h3 class="ln-title">${esc(n.title)}</h3>` : ''}
        ${n.body ? `<p class="ln-body">${esc(n.body)}</p>` : ''}
        ${tags ? `<p class="ln-tags">${tags}</p>` : ''}
      </article>` };
  }));
  if (!el.isConnected || version !== refreshVersion) {
    nextPhotoUrls.forEach(url => URL.revokeObjectURL(url));
    return;
  }
  photoUrls.forEach(url => URL.revokeObjectURL(url));
  photoUrls = nextPhotoUrls;
  const timeline = [...habitItems, ...noteItems].sort((a, b) => b.at - a.at);
  const fab = document.getElementById('fab-life');
  if (!timeline.length) {
    if (fab) fab.hidden = true;
    feed.innerHTML = isCurrent
      ? `<section class="card lf-empty-state"><span class="e-ic life">${iconHtml('ic-book', 20)}</span><h3>留住今天的一点光</h3><p class="sub">可以写日记、记照片，或从一个小习惯开始</p><button class="btn primary" id="lf-empty">写下第一条</button></section>`
      : '<p class="sub" style="padding:12px 4px">这个月没有生活记录</p>';
    return;
  }
  if (fab) fab.hidden = !el.classList.contains('is-active') || !isCurrent;
  feed.innerHTML = timeline.map((item) => item.html).join('') + (isCurrent ? '<div class="lf-fab-space"></div>' : '');
}

/* ── 习惯打卡 ─────────────────── */

/** 打卡 / 取消打卡（checkHabit + kind='habit' 记录双写，时间线可混排） */
async function toggleCheck(habit: Habit): Promise<void> {
  const checked = await isCheckedToday(habit.id);
  if (checked) {
    await uncheckHabit(habit.id, dayKey(Date.now()));
    // 连带移除今天的打卡记录（软删后物理清除，不留回收站噪音）
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const todayNotes = await listLifeNotes({ kind: 'habit', from: dayStart.getTime() });
    for (const n of todayNotes.filter((x) => x.habitId === habit.id)) {
      await softDeleteLifeNote(n.id);
      await purgeLifeNote(n.id);
    }
    showToast(`已取消「${habit.name}」今天的打卡`);
  } else {
    await checkHabit(habit.id);
    await addLifeNote({ kind: 'habit', habitId: habit.id, title: `${habit.name} 打卡`, occurredAt: Date.now() });
    const streak = await habitStreak(habit.id);
    showToast(`「${habit.name}」已打卡 · 连续 ${streak} 天`);
  }
}

/* ── 抽屉：类型选择 / 日记 / 照片 / 习惯 ── */

/** 生活页主操作：选择记录类型 */
function openTypeSheet(): void {
  openSheet({
    ariaLabel: '写一条生活记录',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="lf-sheet-head">
          <p class="sheet-title">写一条生活记录</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="card list" style="margin-top:6px">
          <button class="row lf-type-row" data-type="diary"><span class="e-ic life">${iconHtml('ic-pen', 18)}</span><div class="e-main"><p class="e-title">写日记</p><p class="e-meta">标题、正文、心情、标签，可关联今天的支出</p></div></button>
          <button class="row lf-type-row" data-type="photo"><span class="e-ic life">${iconHtml('ic-camera', 18)}</span><div class="e-main"><p class="e-title">记照片</p><p class="e-meta">选几张照片，配一句话</p></div></button>
          <button class="row lf-type-row" data-type="habit"><span class="e-ic life">${iconHtml('ic-pulse', 18)}</span><div class="e-main"><p class="e-title">新建习惯</p><p class="e-meta">每天打卡，累计连续天数</p></div></button>
        </div>`;
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-act="close"]')) { closeSheet(); return; }
        const type = target.closest<HTMLElement>('[data-type]')?.dataset.type;
        if (type === 'diary') openNoteForm('diary');
        else if (type === 'photo') openNoteForm('photo');
        else if (type === 'habit') openHabitForm();
      }, { signal: sheetSignal() });
    },
  });
}

/** 日记 / 照片的新建与编辑（edit 传入原记录） */
function openNoteForm(kind: 'diary' | 'photo', edit?: LifeNote): void {
  let mood = edit?.mood ?? '';
  /** 新选择的照片文件（仅照片新建；编辑不支持改图，记录在遗留事项） */
  const files: File[] = [];
  const previews: string[] = [];

  openSheet({
    ariaLabel: kind === 'diary' ? '写日记' : '记照片',
    onClose: () => {
      sheetAbort?.abort();
      for (const u of previews) URL.revokeObjectURL(u);
    },
    render(el) {
      el.innerHTML = `
        <div class="lf-sheet-head">
          <p class="sheet-title">${edit ? '编辑' : ''}${kind === 'diary' ? '日记' : '照片记录'}</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <div class="field"><span>标题</span><input class="note" id="lf-title" maxlength="30" placeholder="${kind === 'diary' ? '如 立秋后的第一场雨' : '如 傍晚的晚霞（可不填）'}" value="${esc(edit?.title ?? '')}" style="margin-bottom:0;flex:1"></div>
          ${kind === 'photo' && !edit ? `
          <p class="tiny" style="padding:6px 0 0">选择照片（可多张）</p>
          <div class="lf-photo-grid" id="lf-photos"><button class="lf-photo-add" data-act="pick" aria-label="添加照片">${iconHtml('ic-plus', 20)}</button></div>
          <input type="file" id="lf-file" accept="image/*" multiple hidden>` : ''}
          <p class="tiny" style="padding:6px 0 4px">${kind === 'diary' ? '正文' : '配一句话'}</p>
          <textarea class="note" id="lf-body" placeholder="${kind === 'diary' ? '今天发生了什么…' : '这一刻想说点什么…'}">${esc(edit?.body ?? '')}</textarea>
          ${kind === 'diary' ? `
          <div class="field"><span>心情</span>
            <div class="chip-group" id="lf-mood">
              ${MOODS.map((m) => `<button class="chip${m === mood ? ' active' : ''}" data-mood="${m}">${m}</button>`).join('')}
            </div>
          </div>
          <div class="field"><span>标签</span><input class="note" id="lf-tags" placeholder="逗号分隔，如 下雨,散步" value="${esc((edit?.tags ?? []).join(','))}" style="margin-bottom:0;flex:1"></div>
          <div class="field"><span>关联当日支出</span><input class="note num" id="lf-amt" inputmode="decimal" placeholder="如 20（可不填）" value="${edit?.linkedAmount ? formatFen(edit.linkedAmount).replace(/,/g, '') : ''}" style="margin-bottom:0;width:120px;text-align:right"></div>` : ''}
          <button class="btn primary" data-act="save" style="margin-top:14px">${edit ? '保存修改' : '记下来'}</button>
          ${edit ? '<button class="btn ghost" data-act="del" style="margin-top:10px;color:var(--over)">删除这条记录</button>' : ''}
        </div>`;

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const moodChip = target.closest<HTMLElement>('[data-mood]');
        if (moodChip) {
          mood = mood === moodChip.dataset.mood ? '' : moodChip.dataset.mood!;
          for (const c of el.querySelectorAll<HTMLElement>('[data-mood]')) c.classList.toggle('active', c.dataset.mood === mood);
          return;
        }
        const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'pick') el.querySelector<HTMLInputElement>('#lf-file')!.click();
        else if (act === 'save') void save();
        else if (act === 'del' && edit) void remove(edit);
      }, { signal: sheetSignal() });

      el.querySelector('#lf-file')?.addEventListener('change', (e) => {
        const input = e.target as HTMLInputElement;
        for (const f of input.files ?? []) {
          files.push(f);
          const url = URL.createObjectURL(f);
          previews.push(url);
          el.querySelector('#lf-photos')!.insertAdjacentHTML('afterbegin', `<img src="${url}" alt="${esc(f.name)}">`);
        }
        input.value = '';
      });

      async function save(): Promise<void> {
        const title = el.querySelector<HTMLInputElement>('#lf-title')!.value.trim();
        const body = el.querySelector<HTMLTextAreaElement>('#lf-body')!.value.trim();
        const patch: Partial<NewLifeNote> = { title: title || undefined, body: body || undefined };
        if (kind === 'diary') {
          const tagsRaw = el.querySelector<HTMLInputElement>('#lf-tags')!.value.trim();
          patch.tags = tagsRaw ? tagsRaw.split(/[,，]/).map((t) => t.trim()).filter(Boolean) : undefined;
          patch.mood = mood || undefined;
          const amtRaw = el.querySelector<HTMLInputElement>('#lf-amt')!.value.trim();
          try {
            patch.linkedAmount = amtRaw ? parseYuanToFen(amtRaw) : undefined;
          } catch (err) {
            showToast(err instanceof Error ? err.message : String(err));
            return;
          }
          if (!title && !body) { showToast('写点什么再记下来吧'); return; }
        }
        if (edit) {
          await updateLifeNote(edit.id, patch);
          closeSheet();
          showToast('已保存修改');
          return;
        }
        if (kind === 'photo') {
          if (!files.length) { showToast('先选几张照片'); return; }
          const refs: number[] = [];
          for (const f of files) refs.push(await addAttachment(f, f.name));
          await addLifeNote({ kind: 'photo', ...patch, photoRefs: refs, occurredAt: Date.now() });
        } else {
          await addLifeNote({ kind: 'diary', ...patch, occurredAt: Date.now() });
        }
        closeSheet();
        showToast(kind === 'photo' ? '照片已记下 · 也会出现在首页时间线' : '日记已记下 · 也会出现在首页时间线');
      }
    },
  });
}

/** 删除记录（软删进回收站，30 天可恢复） */
async function remove(note: LifeNote): Promise<void> {
  const ok = await confirmDialog({
    title: `删除「${note.title || (note.kind === 'photo' ? '照片记录' : '日记')}」？`,
    message: '删除后可在回收站找回，保留 30 天。',
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  await softDeleteLifeNote(note.id);
  closeSheet();
  showToast('已删除 · 可在回收站找回');
}

/** 新建习惯 */
function openHabitForm(): void {
  openSheet({
    ariaLabel: '新建习惯',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="lf-sheet-head">
          <p class="sheet-title">新建习惯</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <div class="field"><span>名称</span><input class="note" id="lf-hname" maxlength="12" placeholder="如 晨跑打卡" style="margin-bottom:0;flex:1"></div>
          <p class="tiny" style="padding:6px 0 0">每天在生活页打卡 · 连续天数与近 7 天完成情况会显示在习惯卡上</p>
          <button class="btn primary" data-act="save" style="margin-top:14px">创建</button>
        </div>`;
      el.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'save') {
          const name = el.querySelector<HTMLInputElement>('#lf-hname')!.value.trim();
          if (!name) { showToast('请填写习惯名称'); return; }
          void addHabit(name).then(() => { closeSheet(); showToast(`习惯「${name}」已创建 · 今天就打个卡吧`); });
        }
      }, { signal: sheetSignal() });
    },
  });
}

/** 编辑习惯：改名 / 删除 */
function openHabitEdit(habit: Habit): void {
  openSheet({
    ariaLabel: `编辑习惯：${habit.name}`,
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="lf-sheet-head">
          <p class="sheet-title">编辑习惯「${esc(habit.name)}」</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <div class="field"><span>名称</span><input class="note" id="lf-hname" maxlength="12" value="${esc(habit.name)}" style="margin-bottom:0;flex:1"></div>
          <button class="btn primary" data-act="save" style="margin-top:14px">保存修改</button>
          <button class="btn ghost" data-act="del" style="margin-top:10px;color:var(--over)">删除习惯</button>
          <p class="tiny" style="text-align:center;margin-top:10px">删除习惯会一并清除它的全部打卡记录</p>
        </div>`;
      el.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'save') {
          const name = el.querySelector<HTMLInputElement>('#lf-hname')!.value.trim();
          if (!name) { showToast('请填写习惯名称'); return; }
          void renameHabit(habit.id, name).then(() => { closeSheet(); showToast('已保存修改'); });
        } else if (act === 'del') {
          void confirmDialog({
            title: `删除习惯「${habit.name}」？`,
            message: '会一并清除它的全部打卡记录，不可恢复。',
            okText: '删除',
            danger: true,
          }).then(async (ok) => {
            if (!ok) return;
            await deleteHabit(habit.id);
            closeSheet();
            showToast(`已删除习惯「${habit.name}」`);
          });
        }
      }, { signal: sheetSignal() });
    },
  });
}

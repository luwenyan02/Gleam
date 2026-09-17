export interface LifeWeek {
  /** 周一自然日，YYYY-MM-DD。 */
  key: string;
  /** 本地周一 00:00（含）。 */
  from: number;
  /** 下周一本地 00:00（不含）。 */
  to: number;
  label: string;
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addLocalDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function keyFor(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function weekFromMonday(monday: Date): LifeWeek {
  const to = addLocalDays(monday, 7);
  const end = addLocalDays(to, -1);
  return {
    key: keyFor(monday),
    from: monday.getTime(),
    to: to.getTime(),
    label: `${monday.getMonth() + 1}月${monday.getDate()}日–${end.getMonth() + 1}月${end.getDate()}日`,
  };
}

/** 返回时间戳所在的本地自然周（周一至下周一）。 */
export function lifeWeekForTimestamp(ts: number): LifeWeek {
  if (!Number.isFinite(ts)) throw new Error('生活周时间无效');
  const day = startOfLocalDay(new Date(ts));
  const sinceMonday = (day.getDay() + 6) % 7;
  return weekFromMonday(addLocalDays(day, -sinceMonday));
}

/** 返回当前本地自然周之前的一整周。 */
export function previousLifeWeek(now = Date.now()): LifeWeek {
  const current = lifeWeekForTimestamp(now);
  return weekFromMonday(addLocalDays(new Date(current.from), -7));
}

function parseWeekKey(key: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new Error('weekKey 格式无效');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    throw new Error('weekKey 日期无效');
  }
  if (parsed.getDay() !== 1) throw new Error('weekKey 必须是周一');
  return parsed;
}

/** 从合法周一 weekKey 前后移动若干自然周。 */
export function shiftLifeWeek(key: string, delta: number): LifeWeek {
  if (!Number.isSafeInteger(delta)) throw new Error('周偏移无效');
  return weekFromMonday(addLocalDays(parseWeekKey(key), delta * 7));
}

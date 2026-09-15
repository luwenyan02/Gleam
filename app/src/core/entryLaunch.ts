export type EntryLaunch = { presetType: 'expense' | 'income' } | { templateId: number };

export function parseEntryLaunch(value: string): EntryLaunch | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'shiguang:' || url.host !== 'entry' || url.pathname || url.hash || url.username || url.password) return;
  const pairs = [...url.searchParams];
  if (pairs.length !== 1) return;
  const type = url.searchParams.get('type');
  if (type === 'expense' || type === 'income') return { presetType: type };
  const id = url.searchParams.get('template');
  if (id && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))) return { templateId: Number(id) };
}

export function shortcutTemplates<T extends { id: number }>(templates: T[], recent: unknown): T[] {
  if (!Array.isArray(recent)) return [];
  const byId = new Map(templates.map(template => [template.id, template]));
  return [...new Set(recent)].flatMap(id => byId.has(id) ? [byId.get(id)!] : []).slice(0, 2);
}

export function nextRecentTemplates(recent: unknown, id: number): number[] {
  return [...new Set([id, ...(Array.isArray(recent) ? recent : [])])]
    .filter(value => Number.isSafeInteger(value) && value > 0).slice(0, 20);
}

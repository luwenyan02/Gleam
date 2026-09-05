/**
 * 拾光 · 设置仓库（settingsRepo）
 * kv 存储，读取未命中时回落到 SETTING_DEFAULTS 默认值。
 * 写入成功后 emit 'settings-changed'。
 */
import { db, now } from '../db';
import { emit } from '../store';
import { SETTING_DEFAULTS, type SettingKey } from '../types';

/**
 * 读取设置项；库中未写入时返回 SETTING_DEFAULTS 中的默认值。
 * @param key 设置键（见 types.ts SETTING_DEFAULTS）
 */
export async function getSetting<K extends SettingKey>(key: K): Promise<(typeof SETTING_DEFAULTS)[K]> {
  const row = await db.settings.get(key);
  if (row === undefined) return SETTING_DEFAULTS[key];
  return row.value as (typeof SETTING_DEFAULTS)[K];
}

/**
 * 写入设置项并广播 'settings-changed'。
 */
export async function setSetting<K extends SettingKey>(key: K, value: (typeof SETTING_DEFAULTS)[K]): Promise<void> {
  await db.settings.put({ key, value, updatedAt: now() });
  emit('settings-changed', { key });
}

/**
 * 读取全部设置（默认值与已写入值合并），供设置页整体渲染。
 */
export async function getAllSettings(): Promise<Record<SettingKey, unknown>> {
  const merged: Record<string, unknown> = { ...SETTING_DEFAULTS };
  const rows = await db.settings.toArray();
  for (const r of rows) merged[r.key] = r.value;
  return merged as Record<SettingKey, unknown>;
}

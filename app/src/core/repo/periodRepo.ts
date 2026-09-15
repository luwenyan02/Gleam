import {
  accountingMonthForTimestamp,
  accountingMonthRangeForStartDay,
  validateAccountingMonthStartDay,
  type TimeRange,
} from '../period';
import { getSetting, setSetting } from './settingsRepo';

export async function getAccountingMonthStartDay(): Promise<number> {
  const stored = await getSetting('accounting.monthStartDay');
  return Number.isSafeInteger(stored) && stored >= 1 && stored <= 28 ? stored : 1;
}

export async function setAccountingMonthStartDay(day: number): Promise<void> {
  await setSetting('accounting.monthStartDay', validateAccountingMonthStartDay(day));
}

/** 取时间戳所属财务月键；默认取当前时间。 */
export async function getAccountingMonth(timestamp = Date.now()): Promise<string> {
  return accountingMonthForTimestamp(timestamp, await getAccountingMonthStartDay());
}

/** 财务月键对应的实际起止范围 [from, to)。 */
export async function accountingMonthRange(month: string): Promise<TimeRange> {
  return accountingMonthRangeForStartDay(month, await getAccountingMonthStartDay());
}

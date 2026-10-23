import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SnapshotRow, TableDump } from '../src/core/repo/backupRepo';

let repo: typeof import('../src/core/repo/backupRepo');
let db: typeof import('../src/core/db')['db'];
const name = 'GleamSnapshotDB';
const day = 86400000;

function closeConnections() {
  for (const connection of [...(Dexie as unknown as { connections: Dexie[] }).connections]) connection.close();
}
beforeEach(async () => {
  closeConnections();
  await Dexie.delete(name);
  vi.resetModules();
  ({ db } = await import('../src/core/db'));
  await db.delete();
  await db.open();
  repo = await import('../src/core/repo/backupRepo');
});
afterEach(() => { vi.restoreAllMocks(); closeConnections(); });

function dump(value: string): TableDump {
  return {
    ...Object.fromEntries(repo.TABLE_NAMES.map(table => [table, []])),
    settings: [{ key: 'synthetic.marker', value, updatedAt: 1 }],
  } as TableDump;
}
function legacyRow(id: number, createdAt = id): SnapshotRow {
  return { id, createdAt, reason: 'restore', label: `虚构快照${id}`, counts: { settings: 1 }, tables: dump(`old-${id}`) };
}
async function legacy(rows: SnapshotRow[]) {
  const old = new Dexie(name);
  old.version(1).stores({ snapshots: '++id, createdAt' });
  await old.open();
  await old.table('snapshots').bulkAdd(rows);
  old.close();
}
async function inspect<T>(read: (database: Dexie) => Promise<T>): Promise<T> {
  const database = new Dexie(name);
  await database.open();
  try { return await read(database); } finally { database.close(); }
}
function failContentWrite(id?: number) {
  const put = IDBObjectStore.prototype.put;
  const add = IDBObjectStore.prototype.add;
  for (const [method, original] of [['put', put], ['add', add]] as const) {
    vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'snapshotContents' && (id === undefined || value.id === id)) throw new Error('synthetic storage failure');
      return original.call(this, value, key);
    });
  }
}

it('新建空库时列表为空，快照摘要与完整账本分别保存', async () => {
  expect(await repo.listSnapshots()).toEqual([]);
  await db.settings.put({ key: 'synthetic.marker', value: 'present', updatedAt: 1 });
  const id = await repo.createSnapshot('import', '虚构导入前');
  const rows = await repo.listSnapshots();
  expect(rows).toEqual([expect.objectContaining({ id, reason: 'import', label: '虚构导入前', counts: expect.objectContaining({ settings: 1 }) })]);
  const stored = await inspect(async database => ({
    metadata: await database.table('snapshots').get(id), contents: await database.table('snapshotContents').get(id),
  }));
  expect(stored.metadata).not.toHaveProperty('tables');
  expect(stored.contents.tables.settings).toEqual([{ key: 'synthetic.marker', value: 'present', updatedAt: 1 }]);
});

it.each([0, 1, 3])('事务升级 v1 的 %i 个快照，保留 ID、时间和正文', async count => {
  const rows = Array.from({ length: count }, (_, index) => legacyRow(index + 7));
  await legacy(rows);
  expect(await repo.listSnapshots()).toEqual([...rows].reverse().map(({ tables: _tables, ...metadata }) => metadata));
  await inspect(async database => {
    expect(await database.table('snapshots').toArray()).toEqual(rows.map(({ tables: _tables, ...metadata }) => metadata));
    expect(await database.table('snapshotContents').toArray()).toEqual(rows.map(({ id, tables }) => ({ id, tables })));
  });
  const id = await repo.createSnapshot('category-merge', '虚构合并前');
  expect(id).toBeGreaterThan(count ? count + 6 : 0);
});

it('升级逐条搬移旧正文，不对大快照进行全量值读取', async () => {
  await legacy([legacyRow(1), legacyRow(2), legacyRow(3)]);
  const getAll = IDBObjectStore.prototype.getAll;
  vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'snapshots' && this.transaction.mode === 'versionchange') throw new Error('unbounded full snapshot read');
    return getAll.apply(this, args);
  });
  expect(await repo.listSnapshots()).toHaveLength(3);
  await inspect(async database => { expect(await database.table('snapshotContents').count()).toBe(3); });
});

it('搬移第二个旧快照失败时，整个升级回滚且 v1 原文仍可恢复', async () => {
  const rows = [legacyRow(1), legacyRow(2)];
  await legacy(rows);
  failContentWrite(2);
  await expect(repo.listSnapshots()).rejects.toThrow('synthetic storage failure');
  vi.restoreAllMocks();
  await inspect(async database => {
    expect(database.verno).toBe(1);
    expect(await database.table('snapshots').toArray()).toEqual(rows);
    expect(database.tables.map(table => table.name)).toEqual(['snapshots']);
  });
});

it('列表只读取摘要，不触碰正文存储', async () => {
  const id = await repo.createSnapshot('restore', '虚构恢复前');
  const objectStore = IDBTransaction.prototype.objectStore;
  vi.spyOn(IDBTransaction.prototype, 'objectStore').mockImplementation(function (this: IDBTransaction, storeName) {
    if (storeName === 'snapshotContents') throw new Error('list read full contents');
    return objectStore.call(this, storeName);
  });
  expect(await repo.listSnapshots()).toEqual([expect.objectContaining({ id })]);
});

it('正文写入失败时不留下无效摘要', async () => {
  await repo.listSnapshots();
  failContentWrite();
  await expect(repo.createSnapshot('restore', '虚构失败')).rejects.toThrow('synthetic storage failure');
  expect(await repo.listSnapshots()).toEqual([]);
  await inspect(async database => { expect(await database.table('snapshotContents').count()).toBe(0); });
});

it('过期清理仅读取索引主键，同一事务删除摘要与正文并保留边界', async () => {
  const time = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(time);
  await legacy([legacyRow(1, time - 8 * day), legacyRow(2, time - 7 * day), legacyRow(3, time)]);
  await repo.listSnapshots();
  for (const method of ['getAll', 'openCursor'] as const) {
    const original = IDBIndex.prototype[method];
    vi.spyOn(IDBIndex.prototype, method).mockImplementation(function (this: IDBIndex, ...args: any[]) {
      if (this.objectStore.name === 'snapshots') throw new Error('purge read snapshot values');
      return (original as Function).apply(this, args);
    });
  }
  expect(await repo.purgeSnapshots()).toBe(1);
  vi.restoreAllMocks();
  expect((await repo.listSnapshots()).map(row => row.id)).toEqual([3, 2]);
  await inspect(async database => { expect(await database.table('snapshotContents').toCollection().primaryKeys()).toEqual([2, 3]); });
});

it('撤销迁移的快照恢复原账本，成功后同时删除摘要和正文', async () => {
  await legacy([legacyRow(41)]);
  await db.settings.put({ key: 'synthetic.marker', value: 'new', updatedAt: 2 });
  await repo.undoSnapshot(41);
  expect((await db.settings.get('synthetic.marker'))?.value).toBe('old-41');
  expect(await repo.listSnapshots()).toEqual([]);
  await inspect(async database => { expect(await database.table('snapshotContents').count()).toBe(0); });
  await expect(repo.undoSnapshot(41)).rejects.toThrow('快照不存在');
});

it('恢复失败不删除快照，仍可再次恢复', async () => {
  const row = legacyRow(1);
  row.tables.settings = [{ key: 'duplicate', value: 1 }, { key: 'duplicate', value: 2 }];
  await legacy([row]);
  await db.settings.put({ key: 'synthetic.marker', value: 'keep', updatedAt: 2 });
  await expect(repo.undoSnapshot(1)).rejects.toThrow();
  expect((await db.settings.get('synthetic.marker'))?.value).toBe('keep');
  expect(await repo.listSnapshots()).toHaveLength(1);
  await inspect(async database => { expect((await database.table('snapshotContents').get(1)).tables).toEqual(row.tables); });
});

it('删除正文失败时摘要同步回滚', async () => {
  const id = await repo.createSnapshot('restore', '虚构恢复前');
  const original = IDBObjectStore.prototype.delete;
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
    if (this.name === 'snapshotContents') throw new Error('synthetic delete failure');
    return original.call(this, key);
  });
  await expect(repo.deleteSnapshot(id)).rejects.toThrow('synthetic delete failure');
  expect(await repo.listSnapshots()).toHaveLength(1);
  await inspect(async database => { expect(await database.table('snapshotContents').count()).toBe(1); });
});

it('并发创建与删除后不会出现孤立正文或摘要', async () => {
  const old = await repo.createSnapshot('restore', '虚构旧快照');
  const [first, second] = await Promise.all([
    repo.createSnapshot('import', '虚构导入一'), repo.createSnapshot('import', '虚构导入二'),
    repo.deleteSnapshot(old), repo.deleteSnapshot(old),
  ]);
  expect(first).not.toBe(second);
  expect((await repo.listSnapshots()).map(row => row.id).sort()).toEqual([first, second].sort());
  await inspect(async database => {
    expect(await database.table('snapshotContents').toCollection().primaryKeys()).toEqual([first, second].sort((a, b) => a - b));
  });
});

it('清理正文失败时所有过期摘要和正文均保留，自定义保留期成功后无残留', async () => {
  const time = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(time);
  await legacy([legacyRow(1, time - 3 * day), legacyRow(2, time - 2 * day), legacyRow(3, time)]);
  await repo.listSnapshots();
  const original = IDBObjectStore.prototype.delete;
  const failure = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
    if (this.name === 'snapshotContents') throw new Error('synthetic purge failure');
    return original.call(this, key);
  });
  await expect(repo.purgeSnapshots(1)).rejects.toThrow('synthetic purge failure');
  expect(await repo.listSnapshots()).toHaveLength(3);
  await inspect(async database => { expect(await database.table('snapshotContents').count()).toBe(3); });
  failure.mockRestore();
  expect(await repo.purgeSnapshots(1)).toBe(2);
  expect(await repo.purgeSnapshots(1)).toBe(0);
  await inspect(async database => { expect(await database.table('snapshotContents').toCollection().primaryKeys()).toEqual([3]); });
});

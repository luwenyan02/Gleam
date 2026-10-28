import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let repo: typeof import('../src/core/repo/backupRepo');
let db: typeof import('../src/core/db')['db'];

function closeConnections() {
  for (const connection of [...(Dexie as unknown as { connections: Dexie[] }).connections]) connection.close();
}

beforeEach(async () => {
  closeConnections();
  await Dexie.delete('GleamSnapshotDB');
  vi.resetModules();
  ({ db } = await import('../src/core/db'));
  await db.delete();
  await db.open();
  repo = await import('../src/core/repo/backupRepo');
});

afterEach(() => { vi.restoreAllMocks(); closeConnections(); });

async function prepare(count = 3) {
  const rows = Array.from({ length: count }, (_, i) => ({ id: i + 1, amount: 100 }));
  await db.entries.bulkAdd(rows as never[]);
  await db.accounts.add({ id: 1, name: '虚构快照账户' } as never);
  const id = await repo.createSnapshot('restore', '虚构恢复前');
  await db.entries.clear();
  await db.entries.add({ id: 77, amount: 88 } as never);
  await db.accounts.put({ id: 1, name: '虚构当前账户' } as never);
  return id;
}

it('撤销报告分批进度，明确返回恢复与快照清理均完成', async () => {
  const id = await prepare(2505);
  const steps: { completed: number; total: number }[] = [];
  const result = await repo.undoSnapshot(id, progress => steps.push(progress));
  expect(result).toEqual({ restored: true, snapshotDeleted: true });
  expect(steps[0]).toEqual({ completed: 0, total: 2506 });
  expect(steps).toContainEqual({ completed: 1000, total: 2506 });
  expect(steps.at(-1)).toEqual({ completed: 2506, total: 2506 });
  expect(await db.entries.count()).toBe(2505);
  expect(await db.accounts.get(1)).toEqual({ id: 1, name: '虚构快照账户' });
  expect(await repo.listSnapshots()).toEqual([]);
});

it('撤销迟批写入失败时保留完整原账本与快照，并释放互斥锁', async () => {
  const id = await prepare(3001);
  const add = IDBObjectStore.prototype.add;
  const failure = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === 'entries' && value.id === 1501) value = { ...value, id: 1 };
    return add.call(this, value, key);
  });
  await expect(repo.undoSnapshot(id)).rejects.toThrow();
  expect(await db.entries.toArray()).toEqual([{ id: 77, amount: 88 }]);
  expect(await db.accounts.get(1)).toEqual({ id: 1, name: '虚构当前账户' });
  expect(await repo.listSnapshots()).toHaveLength(1);
  failure.mockRestore();
  await expect(repo.undoSnapshot(id)).resolves.toEqual({ restored: true, snapshotDeleted: true });
  expect(await db.entries.count()).toBe(3001);
});

it('撤销提交后的清理失败返回已恢复结果，不误报账本回滚', async () => {
  const id = await prepare();
  const remove = IDBObjectStore.prototype.delete;
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
    if (this.name === 'snapshotContents') throw new Error('synthetic cleanup failure');
    return remove.call(this, key);
  });
  await expect(repo.undoSnapshot(id)).resolves.toEqual({
    restored: true, snapshotDeleted: false, cleanupError: expect.any(Error),
  });
  expect(await db.entries.count()).toBe(3);
  expect(await db.accounts.get(1)).toEqual({ id: 1, name: '虚构快照账户' });
  expect(await repo.listSnapshots()).toHaveLength(1);
});

it('缺失快照不改当前数据，失败后仍可正常恢复', async () => {
  await db.entries.add({ id: 77, amount: 88 } as never);
  await expect(repo.undoSnapshot(123)).rejects.toThrow('快照不存在');
  expect(await db.entries.toArray()).toEqual([{ id: 77, amount: 88 }]);
  await repo.restoreAll({ entries: [{ id: 99, amount: 100 }] });
  expect(await db.entries.toArray()).toEqual([{ id: 99, amount: 100 }]);
});

it('撤销期间拒绝另一次撤销和文件恢复，避免排队覆盖刚恢复的账本', async () => {
  const id = await prepare(2001);
  const otherId = await repo.createSnapshot('import', '虚构另一快照');
  const results = await Promise.allSettled([
    repo.undoSnapshot(id), repo.undoSnapshot(otherId), repo.restoreAll({ entries: [{ id: 999 }] }),
  ]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
  expect(await db.entries.count()).toBe(2001);
  expect((await repo.listSnapshots()).map(snapshot => snapshot.id)).toEqual([otherId]);
});

it('文件恢复期间也拒绝撤销，完成后允许继续操作', async () => {
  const id = await prepare();
  const results = await Promise.allSettled([
    repo.restoreAll({ entries: [{ id: 999 }] }), repo.undoSnapshot(id),
  ]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(await db.entries.toArray()).toEqual([{ id: 999 }]);
  await expect(repo.undoSnapshot(id)).resolves.toEqual({ restored: true, snapshotDeleted: true });
  expect(await db.entries.count()).toBe(3);
});

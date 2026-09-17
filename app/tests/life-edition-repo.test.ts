import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { lifeWeekForTimestamp } from '../src/core/lifeWeek';
import { addAttachment, addLifeNote, softDeleteLifeNote, updateLifeNote } from '../src/core/repo/lifeRepo';
import {
  deleteLifeEdition, getLifeEdition, getLifeWeekSources, listLifeEditionSummaries, saveLifeEdition,
} from '../src/core/repo/lifeEditionRepo';

const inWeek = new Date(2026, 8, 16, 12).getTime();
const week = lifeWeekForTimestamp(inWeek);

beforeEach(async () => {
  await db.delete();
  await db.open();
});

async function source(body = '周三去公园散步。') {
  const id = await addLifeNote({ kind: 'diary', body, occurredAt: inWeek });
  return (await db.lifeNotes.get(id))!;
}

describe('生活周刊来源与归档', () => {
  it('只列出该自然周内未删除、未排除、非习惯的生活记录', async () => {
    const included = await source();
    await addLifeNote({ kind: 'diary', body: '上周', occurredAt: week.from - 1 });
    await addLifeNote({ kind: 'habit', body: '打卡', habitId: 1, occurredAt: inWeek });
    await addLifeNote({ kind: 'photo', title: '明确排除', occurredAt: inWeek, aiExcluded: true });
    const deleted = await addLifeNote({ kind: 'diary', body: '已删除', occurredAt: inWeek });
    await softDeleteLifeNote(deleted);

    expect((await getLifeWeekSources(week.key)).map(note => note.id)).toEqual([included.id]);
  });

  it('保存时校验来源版本，默认不覆盖；来源内容变化后旧周刊只标记 stale', async () => {
    const note = await source();
    const input = {
      weekKey: week.key,
      title: '这一周，走得很慢',
      blocks: [{ noteId: note.id, text: '周三在公园散步。' }],
      sourceRefs: [{ noteId: note.id, updatedAt: note.updatedAt }],
    };
    await saveLifeEdition(input);
    expect(await getLifeEdition(week.key)).toMatchObject({ status: 'current', edition: { title: input.title } });
    await expect(saveLifeEdition(input)).rejects.toThrow('已存在');

    await db.lifeNotes.update(note.id, { body: '修改后的内容', updatedAt: note.updatedAt + 1 });
    const stale = await getLifeEdition(week.key);
    expect(stale).toMatchObject({ status: 'stale', edition: { title: input.title, blocks: input.blocks } });
    await expect(saveLifeEdition(input, { overwrite: true })).rejects.toThrow('已变化');
  });

  it.each(['excluded', 'deleted'] as const)('%s 来源会阻断并抹去旧标题、正文和封面引用', async action => {
    const attachmentId = await addAttachment(new Blob([new Uint8Array([1])], { type: 'image/png' }), '封面.png');
    const noteId = await addLifeNote({ kind: 'photo', title: '一张照片', occurredAt: inWeek, photoRefs: [attachmentId] });
    const note = (await db.lifeNotes.get(noteId))!;
    await saveLifeEdition({
      weekKey: week.key,
      title: '不可泄露的旧标题',
      blocks: [{ noteId, text: '不可泄露的旧正文' }],
      sourceRefs: [{ noteId, updatedAt: note.updatedAt }],
      coverAttachmentId: attachmentId,
    });
    if (action === 'excluded') await updateLifeNote(noteId, { aiExcluded: true });
    else await softDeleteLifeNote(noteId);

    expect(await getLifeEdition(week.key)).toMatchObject({
      status: 'blocked',
      edition: { title: '', blocks: [], coverAttachmentId: undefined },
    });
    expect(await listLifeEditionSummaries()).toEqual([
      expect.objectContaining({ weekKey: week.key, title: '', status: 'blocked' }),
    ]);
  });

  it('拒绝未知块来源和未属于所选来源的封面，支持显式删除归档', async () => {
    const note = await source();
    const unrelated = await addAttachment(new Blob([new Uint8Array([2])], { type: 'image/png' }), '无关.png');
    await expect(saveLifeEdition({
      weekKey: week.key,
      title: '错误周刊',
      blocks: [{ noteId: 999, text: '恶意注入来源' }],
      sourceRefs: [{ noteId: note.id, updatedAt: note.updatedAt }],
      coverAttachmentId: unrelated,
    })).rejects.toThrow(/来源|封面/);

    await saveLifeEdition({
      weekKey: week.key,
      title: '可删除周刊',
      blocks: [{ noteId: note.id, text: '有效内容' }],
      sourceRefs: [{ noteId: note.id, updatedAt: note.updatedAt }],
    });
    await deleteLifeEdition(week.key);
    expect(await getLifeEdition(week.key)).toBeUndefined();
  });
});

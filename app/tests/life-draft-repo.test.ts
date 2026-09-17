import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { addAccount } from '../src/core/repo/accountRepo';
import { addEntry, softDeleteEntry } from '../src/core/repo/entryRepo';
import { addAttachment, addLifeNote, getLifeNote, linkEntryToLifeNote, listLifeLinkedEntries, listLifeNotes, purgeLifeNote, softDeleteLifeNote } from '../src/core/repo/lifeRepo';
import { deleteLifeDraft, getLifeDraft, migrateLifeDraft, putLifeDraft, saveLifeDraft } from '../src/core/repo/lifeDraftRepo';

const occurredAt = new Date(2026, 8, 15, 12).getTime();
const png = (bytes = 'AQID') => `data:image/png;base64,${bytes}`;

function draft(overrides: Record<string, unknown> = {}) {
  return {
    key: 'composer', title: '一天', body: '先去公园。', occurredAt,
    existingPhotoRefs: [], photos: [], messages: [], aiExcluded: false,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
  await db.open();
});

describe('生活故事草稿仓库', () => {
  it('公开迁移把旧对话与整理稿分开，且重复迁移不丢数据', () => {
    const legacy = draft({
      title: '公园的一天',
      body: '先去公园。',
      messages: [
        { role: 'user', content: '先去公园。' },
        { role: 'assistant', content: '有什么印象深刻的细节？' },
        { role: 'user', content: '看到一只橘猫。' },
      ],
      aiText: '今天在公园看到了一只橘猫。',
      mood: '轻松',
      tags: ['散步'],
    });

    const migrated = migrateLifeDraft(legacy);
    expect(migrated).toMatchObject({
      title: '', body: '', mood: undefined, tags: undefined, aiText: undefined,
      summaryProposal: {
        title: '公园的一天',
        body: '今天在公园看到了一只橘猫。',
        mood: '轻松',
        tags: ['散步'],
        sourceMessageCount: 3,
      },
    });
    expect(migrated.messages.filter(message => message.role === 'user' && message.content === '先去公园。')).toHaveLength(1);
    expect(migrateLifeDraft(migrated)).toEqual(migrated);
    expect(legacy).toMatchObject({ body: '先去公园。', aiText: '今天在公园看到了一只橘猫。' });
  });

  it('公开迁移函数对 unknown 和畸形旧草稿抛出稳定业务错误', () => {
    expect(() => migrateLifeDraft(null)).toThrow('草稿 key 无效');
    expect(() => migrateLifeDraft(draft({ messages: null }))).toThrow('草稿结构无效');
    expect(() => migrateLifeDraft(draft({
      messages: [{ role: 'system', content: '伪造消息' }],
    }))).toThrow('对话草稿结构无效');
    expect(() => migrateLifeDraft(draft({
      messages: [{ role: 'user', content: 42 }],
    }))).toThrow('对话草稿结构无效');
    expect(() => migrateLifeDraft(draft({ tags: ['有效', 3] }))).toThrow('草稿标签无效');
  });

  it('超过 AI 新响应限制的历史标签仍可原样迁移、持久化且幂等', async () => {
    const legacyTags = [...Array.from({ length: 13 }, (_, index) => `历史标签${index + 1}`), '长'.repeat(61)];
    const migrated = migrateLifeDraft(draft({
      body: '历史原话', messages: [], aiText: '历史整理稿', tags: legacyTags,
    }));
    expect(migrated.summaryProposal?.tags).toEqual(legacyTags);
    expect(migrateLifeDraft(migrated)).toEqual(migrated);

    await putLifeDraft(migrated);
    expect((await getLifeDraft('composer'))?.summaryProposal?.tags).toEqual(legacyTags);
  });

  it('纯照片整理稿保留空原话标记，不把 AI 文字冒充用户原话', async () => {
    await putLifeDraft(draft({ body: '', aiText: '照片里的公园。', photos: [{ name: '图.png', dataUrl: png() }] }));
    const noteId = await saveLifeDraft('composer');
    expect(await getLifeNote(noteId)).toMatchObject({ body: '照片里的公园。', originalBody: '' });
  });
  it('确认保存时才把摘要方案与完整会话原子写入正式记录', async () => {
    const messages = [
      { role: 'user' as const, content: '今天去了公园。' },
      { role: 'assistant' as const, content: '有什么小细节想留下？' },
      { role: 'user' as const, content: '池塘边有一只橘猫。' },
    ];
    await putLifeDraft(draft({
      title: '', body: '', messages,
      summaryProposal: {
        title: '池塘边的橘猫', body: '今天去公园，在池塘边看到一只橘猫。',
        mood: '轻松', tags: ['散步', '橘猫'], sourceMessageCount: 3,
      },
    }));
    expect(await getLifeDraft('composer')).toMatchObject({ title: '', body: '', summaryProposal: { title: '池塘边的橘猫' } });
    expect(await listLifeNotes()).toEqual([]);

    const noteId = await saveLifeDraft('composer');
    expect(await getLifeNote(noteId)).toMatchObject({
      title: '池塘边的橘猫', body: '今天去公园，在池塘边看到一只橘猫。',
      mood: '轻松', tags: ['散步', '橘猫'], conversation: messages,
      originalBody: '今天去了公园。\n\n池塘边有一只橘猫。',
    });
    expect(await getLifeDraft('composer')).toBeUndefined();
  });

  it('重新编辑只带新增一轮时追加旧会话，已完整初始化时不重复', async () => {
    const firstConversation = [
      { role: 'user' as const, content: '今天去了公园。' },
      { role: 'assistant' as const, content: '看到了什么？' },
    ];
    await putLifeDraft(draft({
      body: '', messages: firstConversation,
      summaryProposal: { title: '第一版', body: '今天去了公园。', tags: [], sourceMessageCount: 2 },
    }));
    const noteId = await saveLifeDraft('composer');
    const firstNote = (await getLifeNote(noteId))!;
    expect(firstNote.conversation).toEqual(firstConversation);

    const addedTurn = [
      { role: 'user' as const, content: '池塘边有一只橘猫。' },
      { role: 'assistant' as const, content: '它当时在做什么？' },
    ];
    await putLifeDraft(draft({
      key: 'edit-delta', noteId, sourceUpdatedAt: firstNote.updatedAt,
      title: firstNote.title ?? '', body: firstNote.body ?? '', messages: addedTurn,
      summaryProposal: { title: '第二版', body: '今天在公园池塘边看到一只橘猫。', tags: [], sourceMessageCount: 2 },
    }));
    await saveLifeDraft('edit-delta');
    const secondNote = (await getLifeNote(noteId))!;
    const merged = [...firstConversation, ...addedTurn];
    expect(secondNote.conversation).toEqual(merged);

    const finalTurn = [
      { role: 'user' as const, content: '它在晒太阳。' },
      { role: 'assistant' as const, content: '这个片段已经很完整了。' },
    ];
    const completeConversation = [...merged, ...finalTurn];
    await putLifeDraft(draft({
      key: 'edit-full', noteId, sourceUpdatedAt: secondNote.updatedAt,
      title: secondNote.title ?? '', body: secondNote.body ?? '', messages: completeConversation,
      summaryProposal: { title: '最终版', body: '今天在公园看到一只晒太阳的橘猫。', tags: [], sourceMessageCount: completeConversation.length },
    }));
    await saveLifeDraft('edit-full');
    expect((await getLifeNote(noteId))?.conversation).toEqual(completeConversation);
  });

  it('草稿入口拒绝伪造或不完整的摘要方案', async () => {
    await expect(putLifeDraft(draft({
      summaryProposal: { title: '标题', body: '正文', tags: [], sourceMessageCount: -1 },
    }))).rejects.toThrow('摘要');
    await expect(putLifeDraft(draft({
      summaryProposal: { title: '标题', body: '正文', tags: ['有效', 3], sourceMessageCount: 0 },
    }))).rejects.toThrow('摘要');
    await expect(putLifeDraft(draft({
      messages: [], summaryProposal: { title: '标题', body: '正文', tags: [], sourceMessageCount: 1 },
    }))).rejects.toThrow('摘要');
    await expect(putLifeDraft(draft({
      summaryProposal: { title: '标题', body: ' ', tags: [], sourceMessageCount: 0 },
    }))).rejects.toThrow('摘要');
    await expect(putLifeDraft(draft({
      messages: null,
      summaryProposal: { title: '标题', body: '正文', tags: [], sourceMessageCount: 0 },
    }))).rejects.toThrow('草稿结构无效');
  });
  it('旧编辑草稿不得覆盖后来更新的原文或隐私设置', async () => {
    const noteId = await addLifeNote({ kind: 'diary', body: '新正文', occurredAt, aiExcluded: true });
    const note = (await getLifeNote(noteId))!;
    await putLifeDraft(draft({ noteId, sourceUpdatedAt: note.updatedAt - 1, aiExcluded: false }));
    await expect(saveLifeDraft('composer')).rejects.toThrow('更新');
    expect(await getLifeNote(noteId)).toMatchObject({ body: '新正文', aiExcluded: true });
    expect(await getLifeDraft('composer')).toBeDefined();
  });
  it('原记录永久删除后仍保护草稿照片，丢弃最后一份草稿才回收', async () => {
    const photo = await addAttachment(new Blob([new Uint8Array([1])], { type: 'image/png' }), '共享.png');
    const noteId = await addLifeNote({ kind: 'photo', occurredAt, photoRefs: [photo] });
    await putLifeDraft(draft({ existingPhotoRefs: [photo] }));
    await softDeleteLifeNote(noteId);
    await purgeLifeNote(noteId);
    expect(await db.attachments.get(photo)).toBeDefined();
    await deleteLifeDraft('composer');
    expect(await db.attachments.get(photo)).toBeUndefined();
  });
  it('草稿原样持久化，删除只清理草稿内的临时图片数据', async () => {
    await putLifeDraft(draft({ photos: [{ name: '虚构照片.png', dataUrl: png() }] }));
    expect(await getLifeDraft('composer')).toMatchObject({ body: '先去公园。', photos: [{ name: '虚构照片.png' }] });
    expect(await db.attachments.count()).toBe(0);
    await deleteLifeDraft('composer');
    expect(await getLifeDraft('composer')).toBeUndefined();
  });

  it('采用整理稿时正文与完整用户原话分开保存，并原子关联既有账单且不改金额余额', async () => {
    const accountId = await addAccount({ name: '虚构现金', group: 'cash', balance: 10_000 });
    const entryId = await addEntry({ type: 'expense', amount: 1_200, occurredAt, accountId });
    const balanceBefore = (await db.accounts.get(accountId))!.balance;
    await putLifeDraft(draft({
      entryId,
      aiText: '今天散步后心情放松。',
      messages: [
        { role: 'assistant', content: '有什么印象深刻的细节？' },
        { role: 'user', content: '看到一只橘猫。' },
      ],
      photos: [{ name: '橘猫.png', dataUrl: png() }],
      mood: '轻松', tags: ['散步'], review: { verdict: 'again', text: '下周再去' },
    }));

    const noteId = await saveLifeDraft('composer');
    expect(await getLifeNote(noteId)).toMatchObject({
      title: '一天', body: '今天散步后心情放松。',
      originalBody: '先去公园。\n\n看到一只橘猫。',
      mood: '轻松', tags: ['散步'], aiExcluded: false,
      review: { verdict: 'again', text: '下周再去' },
    });
    expect((await getLifeNote(noteId))?.photoRefs).toHaveLength(1);
    expect((await db.entries.get(entryId))?.lifeNoteId).toBe(noteId);
    expect((await db.entries.get(entryId))?.amount).toBe(1_200);
    expect((await db.accounts.get(accountId))?.balance).toBe(balanceBefore);
    expect(await getLifeDraft('composer')).toBeUndefined();
  });

  it('不采用整理稿时只合并用户回答；空草稿拒绝，单张照片可保存', async () => {
    await putLifeDraft(draft({
      body: '原句',
      messages: [{ role: 'assistant', content: '问题' }, { role: 'user', content: '回答' }],
    }));
    const textId = await saveLifeDraft('composer');
    expect(await getLifeNote(textId)).toMatchObject({ body: '原句\n\n回答', originalBody: undefined });

    await putLifeDraft(draft({ key: 'empty', body: ' ', title: '', messages: [] }));
    await expect(saveLifeDraft('empty')).rejects.toThrow('内容');

    await putLifeDraft(draft({ key: 'photo', body: '', photos: [{ name: '一张.png', dataUrl: png() }] }));
    const photoId = await saveLifeDraft('photo');
    expect(await getLifeNote(photoId)).toMatchObject({ kind: 'photo', body: undefined });
  });

  it('账单已删除时要求先解除关联，事务不留下记录或附件且草稿保留', async () => {
    const accountId = await addAccount({ name: '虚构银行卡', group: 'debit', balance: 5_000 });
    const entryId = await addEntry({ type: 'expense', amount: 300, occurredAt, accountId });
    await softDeleteEntry(entryId);
    await putLifeDraft(draft({ entryId, photos: [{ name: '图.png', dataUrl: png() }] }));
    await expect(saveLifeDraft('composer')).rejects.toThrow('解除');
    expect(await db.lifeNotes.count()).toBe(0);
    expect(await db.attachments.count()).toBe(0);
    expect(await getLifeDraft('composer')).toBeDefined();
  });

  it('编辑替换照片时仅回收无人引用的旧附件，并限制图片类型、大小与总数', async () => {
    const old = await addAttachment(new Blob([new Uint8Array([1])], { type: 'image/png' }), '旧图.png');
    const noteId = await addLifeNote({ kind: 'photo', occurredAt, photoRefs: [old] });
    await putLifeDraft(draft({ noteId, body: '', photos: [{ name: '新图.webp', dataUrl: 'data:image/webp;base64,AQ==' }] }));
    await saveLifeDraft('composer');
    expect(await db.attachments.get(old)).toBeUndefined();

    await expect(putLifeDraft(draft({ key: 'bad', photos: [{ name: '坏图.gif', dataUrl: 'data:image/gif;base64,AQ==' }] })))
      .rejects.toThrow('JPG');
    await expect(putLifeDraft(draft({ key: 'many', existingPhotoRefs: Array.from({ length: 10 }, (_, i) => i + 1) })))
      .rejects.toThrow('9');
  });

  it('编辑历史记录时原样保留旧入口接受的图片格式', async () => {
    const legacy = await addAttachment(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/gif' }), '历史动图.gif');
    const noteId = await addLifeNote({ kind: 'photo', title: '旧标题', occurredAt, photoRefs: [legacy] });
    const note = (await getLifeNote(noteId))!;
    await putLifeDraft(draft({
      noteId, sourceUpdatedAt: note.updatedAt, title: '新标题', body: '', existingPhotoRefs: [legacy],
    }));

    await expect(saveLifeDraft('composer')).resolves.toBe(noteId);
    expect(await getLifeNote(noteId)).toMatchObject({ title: '新标题', photoRefs: [legacy] });
    expect(await db.attachments.get(legacy)).toMatchObject({ mime: 'image/gif', size: 3 });
  });
});

describe('账单与生活记录关系仓库', () => {
  it('只链接有效记录并可从公共接口读取，不触碰账务字段', async () => {
    const accountId = await addAccount({ name: '虚构余额', group: 'cash', balance: 2_000 });
    const entryId = await addEntry({ type: 'expense', amount: 500, occurredAt, accountId });
    const noteId = await addLifeNote({ kind: 'diary', body: '关联故事', occurredAt });
    const before = await db.entries.get(entryId);
    await linkEntryToLifeNote(entryId, noteId);
    const after = await db.entries.get(entryId);
    expect(after).toMatchObject({ amount: before?.amount, accountId: before?.accountId, lifeNoteId: noteId });
    expect((await db.accounts.get(accountId))?.balance).toBe(1_500);
    expect((await listLifeLinkedEntries(noteId)).map(entry => entry.id)).toEqual([entryId]);
  });
});

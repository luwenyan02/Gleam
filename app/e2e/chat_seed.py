"""给绕过仓库的虚构 IDB fixture 补齐 v7 派生索引；应用升级另由真实迁移测试覆盖。"""
def index_chat_seed(page):
    page.evaluate('''async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('GleamDB'); r.onsuccess = () => resolve(r.result); });
      const tx = db.transaction(['lifeNotes', 'lifeDrafts'], 'readwrite');
      for (const name of ['lifeNotes', 'lifeDrafts']) {
        const request = tx.objectStore(name).openCursor();
        request.onsuccess = () => {
          const cursor = request.result; if (!cursor) return;
          const row = cursor.value;
          if (name === 'lifeNotes') {
            row.chatOrder = !row.deletedAt && row.conversation?.length ? row.updatedAt : undefined;
            row.chatTitle = (row.title || row.conversation?.[0]?.content || '照片里的片刻').slice(0, 80);
          } else {
            const listed = row.key?.startsWith('chat:') && (row.messages?.length || row.photos?.length || row.pendingReply?.trim() || row.aiText || row.summaryProposal);
            row.chatOrder = listed ? row.chatUpdatedAt ?? row.occurredAt : undefined;
            row.chatTitle = (row.messages?.find(message => message.role === 'user')?.content || row.pendingReply || '照片里的片刻').slice(0, 80);
            row.chatNoteId = listed ? row.noteId ?? 0 : undefined;
          }
          cursor.update(row); cursor.continue();
        };
      }
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
    }''')

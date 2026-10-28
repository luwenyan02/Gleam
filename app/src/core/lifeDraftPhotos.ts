import type { LifeDraft, LifeDraftPhoto } from './types';

export function lifeDraftPhotos(draft: LifeDraft): LifeDraftPhoto[] {
  return [...draft.photos, ...draft.messages.flatMap(message => message.photos ?? [])];
}

export function lifeDraftAttachmentRefs(draft: LifeDraft): number[] {
  return [...new Set([...draft.existingPhotoRefs, ...draft.messages.flatMap(message => message.photoRefs ?? []),
    ...lifeDraftPhotos(draft).flatMap(photo => photo.attachmentId == null ? [] : [photo.attachmentId])])];
}

/** 原图字符串不可变，只复制图片对象；文字快照不重复克隆数 MB 的原图。 */
export function copyLifeDraft(draft: LifeDraft): LifeDraft {
  const copy: LifeDraft = structuredClone({ ...draft, photos: [], messages: draft.messages.map(({ photos: _photos, ...message }) => message) });
  copy.photos = draft.photos.map(photo => ({ ...photo }));
  copy.messages.forEach((message, index) => {
    if (draft.messages[index].photos) message.photos = draft.messages[index].photos!.map(photo => ({ ...photo }));
  });
  return copy;
}

import { expect, it } from 'vitest';
import { parseEntryLaunch, shortcutTemplates, nextRecentTemplates } from '../src/core/entryLaunch';

it('快捷链接只接受记账白名单与正整数模板编号', () => {
  expect(parseEntryLaunch('shiguang://entry?type=expense')).toEqual({ presetType: 'expense' });
  expect(parseEntryLaunch('shiguang://entry?type=income')).toEqual({ presetType: 'income' });
  expect(parseEntryLaunch('shiguang://entry?template=12')).toEqual({ templateId: 12 });
  for (const url of ['https://entry?type=expense', 'shiguang://settings?type=expense', 'shiguang://entry?template=-1', 'shiguang://entry?template=1.5', 'shiguang://entry?template=0', 'shiguang://entry?type=delete', 'shiguang://entry?template=1&type=income']) {
    expect(parseEntryLaunch(url)).toBeUndefined();
  }
});
it('只保留最近两张仍存在的模板，忽略备份中的无效编号', () => {
  const templates = [{ id: 1 }, { id: 2 }, { id: 3 }];
  expect(shortcutTemplates(templates, [9, 3, 3, 2, 1])).toEqual([{ id: 3 }, { id: 2 }]);
  expect(shortcutTemplates(templates, [])).toEqual([]);
  expect(shortcutTemplates(templates, null)).toEqual([]);
  expect(nextRecentTemplates([2, 1, 2], 1)).toEqual([1, 2]);
});

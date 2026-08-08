import { Category } from './Model';
import { Note } from 'richeditor';
import { KVStore, KVStoreType, SerializeUtil } from 'serializer';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG: string = '[MockData]';

/**
 * 测试用 mock 数据工厂。生成分类与笔记，供 EntryAbility 启动时 seed 到 KVStore。
 */

const MOCK_CATEGORY_NAMES: string[] = [
  '工作', '生活', '学习', '旅行', '灵感',
  '健康', '阅读', '项目', '家庭', '收藏',
];

const MOCK_NOTE_TITLES: string[] = [
  '周会议程整理', '晨跑计划', 'ArkTS 学习笔记', '青海湖行程', '产品创意清单',
  '体检安排', '三体读后感', '一多适配方案', '周末家庭聚餐', '收藏的链接合集',
];

const MOCK_NOTE_CONTENTS: string[] = [
  '本周需讨论的事项与待办。', '每周三五晨跑五公里。', '状态管理 V2 与 Builder 用法记录。',
  'Day1 西宁，Day2 茶卡，Day3 环湖。', '离线优先、增量同步、端侧 AI。',
  '预约下周三上午空腹体检。', '黑暗森林法则的推演。', '断点驱动布局与测试用例拆分。',
  '采购清单与餐厅预订。', '技术博客、开源仓库、文档。',
];

const BASE_TIME: number = 1700000000000;

/** 生成 n 条普通分类（不含"全部笔记"，该默认分类由 initCategoryList 提供，避免与 KVStore 叠加重复）。 */
export function mockCategories(n: number = 10): Category[] {
  const list: Category[] = [];
  const count = Math.min(n, MOCK_CATEGORY_NAMES.length);
  for (let i = 0; i < count; i++) {
    list.push(new Category(MOCK_CATEGORY_NAMES[i], 0, `mock_cat_${i}`));
  }
  return list;
}

/** 生成 n 条笔记，categoryId 均匀分配到 mock 分类，id/time 固定。 */
export function mockNotes(n: number = 10): Note[] {
  const notes: Note[] = [];
  const count = Math.min(n, MOCK_NOTE_TITLES.length);
  for (let i = 0; i < count; i++) {
    const note = new Note(new MutableStyledString(MOCK_NOTE_CONTENTS[i]), MOCK_NOTE_TITLES[i]);
    note.id = `mock_note_${i}`;
    note.createTime = `${BASE_TIME + i * 1000}`;
    note.updateTime = `${BASE_TIME + i * 1000}`;
    note.categoryId = (i % 2 === 0) ? '-1' : `mock_cat_${i % MOCK_CATEGORY_NAMES.length}`;
    notes.push(note);
  }
  return notes;
}

/**
 * 将 mock 分类与笔记 seed 到 KVStore。每次启动调用，先清旧再写新，保证幂等。
 * key 格式与 NoteService/CategoryService 读取一致：
 *   分类：Category_<id>；笔记：EffectiveNote_<id>
 */
export async function seedMockData(kvStore: KVStore, uiContext: UIContext,
  noteCount: number = 10, categoryCount: number = 10): Promise<void> {
  try {
    // 清旧数据（幂等：每次启动重建）
    const oldNotes = await kvStore.getAll('EffectiveNote');
    oldNotes?.forEach((d: KVStoreType): void => {
      kvStore.delete(d.key);
    });
    const oldCats = await kvStore.getAll('Category_');
    oldCats?.forEach((d: KVStoreType): void => {
      kvStore.delete(d.key);
    });

    // 写分类（@ObservedV2 序列化带 __ob_ 前缀，需去除以匹配 loadCategoryList 读取）
    mockCategories(categoryCount).forEach((c: Category): void => {
      kvStore.put(`Category_${c.id}`, JSON.stringify(c).replace(/__ob_/g, ''));
    });

    // 写笔记（需序列化 StyledString）
    const notes = mockNotes(noteCount);
    for (const note of notes) {
      const serialized = await SerializeUtil.serialize(note.styledString, uiContext);
      note.serializedStyledString = serialized;
      kvStore.put(`EffectiveNote_${note.id}`, JSON.stringify(note).replace(/__ob_/g, ''));
    }
    hilog.info(0x0000, TAG, `seedMockData: 已写入 ${categoryCount} 分类、${noteCount} 笔记`);
  } catch (e) {
    hilog.error(0x0000, TAG, `seedMockData 失败: ${(e as Error).message}`);
  }
}

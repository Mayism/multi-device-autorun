import { formBindingData, FormExtensionAbility, formInfo } from '@kit.FormKit';
import { Configuration, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { distributedKVStore } from '@kit.ArkData';
import { KVStore } from 'serializer';
import { CategoryService, NoteService } from '@ohos_agcit/notes_datasource';
import { PreferencesUtil } from '@ohos_agcit/notes_datasource/src/main/ets/PreferencesUtil';

const TAG: string = 'EntryFormAbility';
const DOMAIN_NUMBER: number = 0xFF00;

interface NoteData {
  hasNotes: string | number | bigint | true | object;
  hasTwoNotes: string | number | bigint | true | object;
  firstNoteTitle: string | number | bigint | true | object;
  firstNoteTime: string | number | bigint | true | object;
  secondNoteTitle: string | number | bigint | true | object;
  secondNoteTime: string | number | bigint | true | object;
  totalNotesCount: string | number | bigint | true | object;
}

export default class EntryFormAbility extends FormExtensionAbility {
  private kvManager: distributedKVStore.KVManager | null = null;
  categoryService: CategoryService = CategoryService.instance;

  noteService: NoteService = NoteService.instance;
  kvStore: KVStore | undefined = undefined;

  onAddForm(want: Want): formBindingData.FormBindingData {
    const formId = want.parameters![formInfo.FormParam.IDENTITY_KEY] as string;
    const preferencesUtil = PreferencesUtil.getInstance();
    const preference = preferencesUtil.getPreferences(this.context);
    preferencesUtil.addFormId(preference, formId);

    const count = preferencesUtil.getPreferencesValue(preference, 'totalNotesCount');

    // 2. 从preferences中读取笔记数据
    const hasNotes = preferencesUtil.getPreferencesValue(preference, 'hasNotes') || '';
    const hasTwoNotes = preferencesUtil.getPreferencesValue(preference, 'hasTwoNotes') || '';
    const firstNoteTitle = preferencesUtil.getPreferencesValue(preference, 'firstNoteTitle') || '';
    const firstNoteTime = preferencesUtil.getPreferencesValue(preference, 'firstNoteTime') || '';
    const secondNoteTitle = preferencesUtil.getPreferencesValue(preference, 'secondNoteTitle') || '';
    const secondNoteTime = preferencesUtil.getPreferencesValue(preference, 'secondNoteTime') || '';
    const totalNotesCount = preferencesUtil.getPreferencesValue(preference, 'totalNotesCount') || '';


    const data: NoteData = {
      hasNotes: hasNotes,
      hasTwoNotes: hasTwoNotes,
      firstNoteTitle: firstNoteTitle,
      firstNoteTime: firstNoteTime,
      secondNoteTitle: secondNoteTitle,
      secondNoteTime: secondNoteTime,
      totalNotesCount: totalNotesCount,
    };

    return formBindingData.createFormBindingData(data);
  }

  onCastToNormalForm(formId: string): void {
    hilog.info(DOMAIN_NUMBER, TAG, '[EntryFormAbility] onCastToNormalForm');
  }

  async onUpdateForm(formId: string): Promise<void> {
    hilog.info(DOMAIN_NUMBER, TAG, '[EntryFormAbility] onUpdateForm');
  }

  onChangeFormVisibility(newStatus: Record<string, number>): void {
    hilog.info(DOMAIN_NUMBER, TAG, '[EntryFormAbility] onChangeFormVisibility');
  }

  onFormEvent(formId: string, message: string): void {
    hilog.info(DOMAIN_NUMBER, TAG, `FormAbility onFormEvent, formId = ${formId}, message: ${message}`);
  }

  onRemoveForm(formId: string): void {
    hilog.info(DOMAIN_NUMBER, TAG, '[EntryFormAbility] onRemoveForm');
  }

  onConfigurationUpdate(config: Configuration): void {
    hilog.info(DOMAIN_NUMBER, TAG, '[EntryFormAbility] onConfigurationUpdate:' + JSON.stringify(config));
  }

  onAcquireFormState(want: Want): formInfo.FormState {
    return formInfo.FormState.READY;
  }

  /**
   * 格式化时间戳为可读格式
   */
  private formatDate(timestamp: string): string {
    try {
      const timeNum = parseInt(timestamp);
      if (!timeNum || timeNum <= 0) {
        return '';
      }

      const date = new Date(timeNum);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const noteDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

      // 如果是今天，只显示时间
      if (noteDate.getTime() === today.getTime()) {
        return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
      }

      // 否则显示月日
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    } catch (error) {
      return '';
    }
  }

  /**
   * 获取默认卡片数据（无数据或出错时使用）
   */
  private getDefaultCardData(): Record<string, string | number | object> {
    return {
      'title': '笔记卡片',
      'createTime': '',
      'notesCount': 0,
      'recentNoteTitles': [],
      'timestamp': new Date().toISOString(),
      'status': 'no_data',
    };
  }
};
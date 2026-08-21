/*
 * Copyright (c) 2024 Huawei Device Co., Ltd.
 * Licensed under the Apache License,Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { AbilityConstant, common, Want } from '@kit.AbilityKit';
import { AppStorageV2 } from '@kit.ArkUI';
import { ContinueModel } from '../model/ContinueModel';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = '[ContinueUtils]';
const DOMAIN_ID = 0x0000;

/**
 * 应用接续工具类
 * 简化版：只传输笔记ID和标题
 */
export class ContinueUtils {
  private static instance: ContinueUtils;

  public static getInstance(): ContinueUtils {
    if (!ContinueUtils.instance) {
      ContinueUtils.instance = new ContinueUtils();
    }
    return ContinueUtils.instance;
  }

  /**
   * 处理源端接续请求
   * 在Ability的onContinue中调用
   */
  public static handleSourceContinue(
    wantParam: Record<string, Object>,
    context: common.UIAbilityContext
  ): AbilityConstant.OnContinueResult {
    hilog.info(DOMAIN_ID, TAG, '开始处理源端接续请求');

    try {
      const continueModel: ContinueModel = AppStorageV2.connect(ContinueModel, () => new ContinueModel())!;

      // 1. 检查是否有打开的笔记
      if (!continueModel.noteId) {
        hilog.warn(DOMAIN_ID, TAG, '没有打开的笔记，拒绝接续');
        return AbilityConstant.OnContinueResult.REJECT;
      }

      // 2. 保存笔记ID和标题到wantParam
      wantParam.noteId = continueModel.noteId;
      wantParam.noteTitle = continueModel.noteTitle;

      hilog.info(DOMAIN_ID, TAG,
        `接续数据保存成功: noteId=${continueModel.noteId}, title=${continueModel.noteTitle}`);

      return AbilityConstant.OnContinueResult.AGREE;

    } catch (error) {
      hilog.error(DOMAIN_ID, TAG, `接续处理失败: ${JSON.stringify(error)}`);
      return AbilityConstant.OnContinueResult.REJECT;
    }
  }

  /**
   * 更新接续数据
   * 在编辑页面打开或保存笔记时调用
   * @param noteId 笔记ID
   * @param noteTitle 笔记标题
   */
  public static updateContinueData(noteId: string, noteTitle: string): void {
    if (!noteId || !noteTitle) {
      hilog.warn(DOMAIN_ID, TAG, `无效的笔记数据: noteId=${noteId}, title=${noteTitle}`);
      return;
    }

    const continueModel: ContinueModel = AppStorageV2.connect(ContinueModel, () => new ContinueModel())!;

    // 目标端设备不更新源端数据
    if (continueModel.isTargetDevice) {
      hilog.debug(DOMAIN_ID, TAG, '目标端设备，不更新接续数据');
      return;
    }

    // 更新接续数据
    continueModel.noteId = noteId;
    continueModel.noteTitle = noteTitle;

    hilog.debug(DOMAIN_ID, TAG, `更新接续数据: noteId=${noteId}, title=${noteTitle}`);
  }

  // ==================== 目标端设备方法 ====================

  /**
   * 处理目标端接续恢复
   * 在Ability的onCreate/onNewWant中调用
   */
  public static handleTargetContinue(want: Want, context: common.UIAbilityContext): void {
    hilog.info(DOMAIN_ID, TAG, '开始处理目标端接续恢复');

    const continueModel: ContinueModel = AppStorageV2.connect(ContinueModel, () => new ContinueModel())!;

    if (want.parameters === undefined) {
      hilog.warn(DOMAIN_ID, TAG, '接续参数为空');
      return;
    }

    // 恢复接续数据
    continueModel.isTargetDevice = true;
    continueModel.noteId = want.parameters.noteId as string || '';
    continueModel.noteTitle = want.parameters.noteTitle as string || '';

    hilog.info(DOMAIN_ID, TAG,
      `接续数据恢复成功: noteId=${continueModel.noteId}, title=${continueModel.noteTitle}`);

    // 激活接续能力（保证可以接续回去）
    ContinueUtils.enableContinue(context);
  }

  /**
   * 清除接续标记
   * 在目标端恢复完成后调用
   */
  public static clearContinueFlag(): void {
    const continueModel: ContinueModel = AppStorageV2.connect(ContinueModel, () => new ContinueModel())!;
    continueModel.isTargetDevice = false;
    continueModel.noteId = '';
    continueModel.noteTitle = '';
    hilog.debug(DOMAIN_ID, TAG, '清除接续标记');
  }

  /**
   * 清除接续数据（源端设备退出编辑时调用）
   */
  public static clearContinueData(): void {
    const continueModel: ContinueModel = AppStorageV2.connect(ContinueModel, () => new ContinueModel())!;
    continueModel.noteId = '';
    continueModel.noteTitle = '';
    hilog.debug(DOMAIN_ID, TAG, '清除接续数据');
  }

  // ==================== 接续能力控制 ====================

  /**
   * 激活接续能力
   */
  public static enableContinue(context: common.UIAbilityContext): void {
    if (!context) {
      hilog.error(DOMAIN_ID, TAG, 'context为空，无法激活接续能力');
      return;
    }

    context.setMissionContinueState(AbilityConstant.ContinueState.ACTIVE)
      .then(() => {
        hilog.info(DOMAIN_ID, TAG, '接续能力已激活');
      })
      .catch((error: Error) => {
        hilog.error(DOMAIN_ID, TAG, `激活接续能力失败: ${error.message}`);
      });
  }

  /**
   * 关闭接续能力
   */
  public static disableContinue(context: common.UIAbilityContext): void {
    if (!context) {
      hilog.error(DOMAIN_ID, TAG, 'context为空，无法关闭接续能力');
      return;
    }

    context.setMissionContinueState(AbilityConstant.ContinueState.INACTIVE)
      .then(() => {
        hilog.info(DOMAIN_ID, TAG, '接续能力已关闭');
      })
      .catch((error: Error) => {
        hilog.error(DOMAIN_ID, TAG, `关闭接续能力失败: ${error.message}`);
      });
  }

  // ==================== 工具方法 ====================

  /**
   * 检查是否接续场景
   * @returns 如果是目标端接续场景返回true
   */
  public static isContinueScene(): boolean {
    const continueModel: ContinueModel = AppStorageV2.connect(ContinueModel, () => new ContinueModel())!;
    return continueModel.isTargetDevice && continueModel.noteId !== '';
  }

  /**
   * 获取接续的笔记ID
   */
  public static getContinueNoteId(): string {
    const continueModel: ContinueModel = AppStorageV2.connect(ContinueModel, () => new ContinueModel())!;
    return continueModel.noteId;
  }

  /**
   * 获取接续的笔记标题
   */
  public static getContinueNoteTitle(): string {
    const continueModel: ContinueModel = AppStorageV2.connect(ContinueModel, () => new ContinueModel())!;
    return continueModel.noteTitle;
  }

  /**
   * 检查是否有打开的笔记（源端）
   */
  public static hasOpenNote(): boolean {
    const continueModel: ContinueModel = AppStorageV2.connect(ContinueModel, () => new ContinueModel())!;
    return !continueModel.isTargetDevice && continueModel.noteId !== '';
  }

  /**
   * 获取接续数据
   */
  public static getContinueData(): ContinueModel | null {
    const continueModel: ContinueModel = AppStorageV2.connect(ContinueModel, () => new ContinueModel())!;
    if (!continueModel.noteId) {
      return null;
    }
    return {
      noteId: continueModel.noteId,
      noteTitle: continueModel.noteTitle,
      isTargetDevice: continueModel.isTargetDevice
    };
  }
}
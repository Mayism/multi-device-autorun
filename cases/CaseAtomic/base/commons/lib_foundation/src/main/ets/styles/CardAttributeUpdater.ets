import { AttributeUpdater } from '@kit.ArkUI';

/**
 * 卡片updater
 */
export class CardAttributeUpdater extends AttributeUpdater<ColumnAttribute | RowAttribute> {
  initializeModifier(instance: CommonAttribute) {
    // 普通卡片
    instance
      .width('100%')
      .backgroundColor($r('sys.color.comp_background_primary'))
      .borderRadius(16)
      .padding(12)
  }
}

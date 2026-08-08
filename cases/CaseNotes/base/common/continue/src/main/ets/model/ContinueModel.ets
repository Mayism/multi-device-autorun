@ObservedV2
export class ContinueModel {
  @Trace noteId: string = '';                   // 笔记ID
  @Trace noteTitle: string = '';                // 笔记标题
  @Trace isTargetDevice: boolean = false;       // 是否为接收设备
}
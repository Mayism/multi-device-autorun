import { webview } from '@kit.ArkWeb';

@Entry
@ComponentV2
struct Index {

  private controller: webview.WebviewController = new webview.WebviewController();

  public build(): void {
    Column() {
      Web({ controller: this.controller, src: 'http://10.0.2.2:5175' })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .width('100%')
        .height('100%')
    }
    .height('100%')
    .width('100%')
  }
}

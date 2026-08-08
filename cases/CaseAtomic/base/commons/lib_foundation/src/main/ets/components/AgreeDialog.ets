import { CommonConstants } from '../constants/CommonConstants'
import { SafeUtil } from '../utils/SafeUtil'

@Builder
export function agreeDialogBuilder() {
  AgreeDialog()
}

@ComponentV2
struct AgreeDialog {
  build() {
    NavDestination() {
      Column() {
        Column() {
          Scroll() {
            Column() {
              Text('您需要同意协议才能体验新闻模板')
                .fontSize($r('sys.float.Title_S'))
                .fontWeight(FontWeight.Bold)
              Text('天气模板 App 隐私协议\n' +
                '本隐私协议适用于 [App 开发者 / 公司名称] 开发和运营的天气模板 App（以下简称 “本 App”）。我们深知个人信息对您的重要性，始终致力于保护您的隐私。本隐私协议将向您详细说明我们如何收集、使用、存储和共享您的个人信息，以及您所拥有的权利。在使用本 App 前，请仔细阅读并理解本隐私协议的内容。\n' +
                '一、我们如何收集您的个人信息\n' +
                '（一）注册与登录信息\n' +
                '当您注册或登录本 App 时，我们可能会收集您的手机号码、电子邮箱地址、用户名和密码。手机号码和电子邮箱用于验证您的身份及后续的账号安全操作，如找回密码等。用户名用于展示您在 App 内的身份标识。若您选择使用第三方账号（如微信、QQ 等）登录，我们会在您授权同意的情况下，获取您在第三方平台的昵称、头像等公开信息，以便为您提供便捷的登录服务。\n' +
                '（二）使用过程中收集的信息\n' +
                '搜索记录：当您在 App 内进行家装搜索时，我们会收集您输入的关键词。这些信息有助于为您提供更精准的搜索结果，且通常情况下无法单独识别您的个人身份。但当搜索关键词与其他可识别信息结合时，将按照个人信息进行处理与保护。\n' +
                '浏览与收藏记录：我们会记录您浏览过的家装案例页面、收藏的装修案例内容等信息。通过这些信息，我们可以为您提供个性化的推荐服务，例如向您推荐您可能感兴趣的相似家装案例。\n' +
                '发布与互动信息：若您在 App 内发布评论、点赞等，我们会收集您发布的文字、图片、视频等内容。同时，我们会记录您与其他用户的互动情况，如您回复他人评论等信息，以维护 App 内的社交互动环境。\n' +
                '（三）设备信息\n' +
                '为保障 App 的稳定运行及安全，我们会收集您的设备相关信息，包括设备型号、操作系统版本、唯一设备标识符、IP 地址、浏览器类型等。这些信息有助于我们分析设备兼容性问题、排查故障以及防范安全风险。\n')
                .fontSize($r('sys.float.Caption_M'))
                .margin({ top: 16, bottom: 16 })

              Text('请您仔细阅读上述声明，点击“同意”，即表示您知悉并同意我们向您提供本应用服务。')
                .fontSize($r('sys.float.Caption_M'))
                .fontColor($r('sys.color.font_secondary'))
            }

          }
          .id('ss_agree_dialog_scroll')
          Row({ space: CommonConstants.SPACE_16 }) {
            Button('退出应用')
              .fontColor($r('app.color.common_theme_color'))
              .backgroundColor($r('sys.color.comp_background_tertiary'))
              .height(40)
              .layoutWeight(1)
              .onClick(() => {
                getContext().getApplicationContext().killAllProcesses();
              })
            Button('同意并继续')
              .height(40)
              .layoutWeight(1)
              .onClick(() => {
                SafeUtil.setAgreed();
              })
          }
          .margin({ top: 24 })
          .height(56)
          .alignItems(VerticalAlign.Top)
          .position({
            bottom: 0,
            left: 0
          })
        }
        .backgroundColor(Color.White)
        .width(CommonConstants.FULL_PERCENT)
        .borderRadius(32)
        .padding(CommonConstants.SPACE_16)
        .id('ss_agree_dialog')
        .constraintSize({
          maxHeight: '80%'
        })
      }
      .justifyContent(FlexAlign.Center)
      .height(CommonConstants.FULL_PERCENT)
      .width(CommonConstants.FULL_PERCENT)
      .justifyContent(FlexAlign.Center)
      .padding({
        left: CommonConstants.SPACE_16,
        right: CommonConstants.SPACE_16,
      })
    }
    .hideTitleBar(true)
    .mode(NavDestinationMode.DIALOG)
    .backgroundColor('rgba(0,0,0,0.5)')
    .onBackPressed(() => {
      return true;
    })
  }
}

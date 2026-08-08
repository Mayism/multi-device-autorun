import { NewsEnum, VideoEnum } from '../../constants/Constants';
import { BaseNews } from '../../database/NewsType';

export class MockVideo {
  // 正在直播2条、即将直播4条、精彩回放8条
  static liveVideoList: BaseNews[] = [
    // 正在直播
    {
      id: 'live_video1',
      type: NewsEnum.Video,
      title: '新技术通话，让每一次连接超越想象',
      tags: ['新科技', '通话', '链接', '科技'],
      authorId: 'author_1',
      createTime: new Date().getTime(),
      commentCount: 10,
      markCount: 0,
      likeCount: 1,
      shareCount: 0,
      isLiked: true,
      isMarked: false,
      recommends: [{
        newsId: 'article_10',
        newsType: 1,
      }, {
        newsId: 'article_11',
        newsType: 1,
      }],
      postImgList: [
        {
          picVideoUrl: 'https://agc-storage-drcn.platform.dbankcloud.cn/v0/asdf-qf3d5/testVideo2.mp4?token=dbbeb9c3-3f9c-4c28-ae57-cd9efa3a4b60',
          surfaceUrl: 'https://www-file.huawei.com/admin/asset/v1/pro/view/6c813cb0874744f4b54fd61f1f9e8f24.jpg',
        },
      ],
      videoUrl: 'https://agc-storage-drcn.platform.dbankcloud.cn/v0/asdf-qf3d5/testVideo2.mp4?token=dbbeb9c3-3f9c-4c28-ae57-cd9efa3a4b60',
      coverUrl: 'https://www-file.huawei.com/admin/asset/v1/pro/view/6c813cb0874744f4b54fd61f1f9e8f24.jpg',
      videoType: VideoEnum.Landscape,
      videoDuration: 134506,
      navInfo: {
        setting: '{"type":"view","children":[{"type":"view","children":[{"type":"List","children":[{"type":"native","showType":"TopTextBottomVideoCard","name":"视频"}],"style":{"backgroundColor":"#FFFFFF","padding-bottom":"12","margin-top":"12"}}]}]}',
      },
      liveStartTime: Date.now() - 2 * 60 * 1000, // 2分钟前开始
      liveEndTime: Date.now() - 2 * 60 * 1000 + 60 * 60 * 1000, // 直播60分钟
    },
  ]
  static list: BaseNews[] = [
    ...MockVideo.liveVideoList,
  ];
}
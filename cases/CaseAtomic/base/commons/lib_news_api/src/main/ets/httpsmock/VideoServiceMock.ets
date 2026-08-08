import AxiosMockAdapter from '@hw-agconnect/axios-mock-adapter';
import { AxiosRequestConfig, HttpStatusCode } from '@ohos/axios';
import { MockVideo } from './mockdata/MockVideo';
import { VideoListRequest } from '../params/request/CommonRequest';

/**
 * 新闻视频Mock
 */
export class VideoServiceMock {

  public start(adapter: AxiosMockAdapter) {

    // 查询视频流，如果有userId，查询对应用户的视频
    adapter.onGet('/video/author/list').reply((config: AxiosRequestConfig) => {
      const params = config.params as VideoListRequest;
      let list = MockVideo.list;
      if (params.userId) {
        list = list.filter(v => v.authorId === params.userId)
      }
      return [HttpStatusCode.Ok, list];
    });

  }
}
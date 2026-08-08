import request from '../common/BaseRequest';
import { BaseNewsService } from './BaseNewsService';
import { NewsResponse } from '../params/response/NewsResponse';


/**
 * 新闻-视频类
 */
export class VideoService extends BaseNewsService {

  /**
   * 查询视频流，如果有userId，查询对应用户的视频
   * 需要区分是纯视频还是发的动态中的视频
   * @param userId
   * @param type
   * @returns
   */
  public queryVideoList(userId: string = '', type: number): Promise<NewsResponse[]> {
    return request.get('/video/author/list', { params: { userId, type } });
  }

}

const instance = new VideoService();

export { instance as VideoServiceApi };
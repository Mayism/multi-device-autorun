import request from '../common/BaseRequest';
import { NewsResponse } from '../params/response/NewsResponse';

/**
 * 新闻基础类
 */
export class BaseNewsService {
  /**
   * 查询作者的所有创作内容
   * @param userId
   * @returns
   */
  public queryAllNews(userId: string): Promise<NewsResponse[]> {
    return request.get('/author/news/list', { params: { authorId: userId } });
  }

}

const instance = new BaseNewsService();

export { instance as BaseNewsServiceApi };
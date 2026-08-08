import { NavInfo } from '../base/BaseModel'
import { NewsResponse } from './NewsResponse'

@ObservedV2
export class AbstractRequestListData {
  abstract: string = ''
  list: RequestListData[] = [];
}

@ObservedV2
export class RequestListData<T = NewsResponse> {
  navInfo: NavInfo = new NavInfo()
  @Trace articles: T[] = []
  extraInfo: Record<string, string | number | boolean | Record<string, string | boolean>[]> = {}
}
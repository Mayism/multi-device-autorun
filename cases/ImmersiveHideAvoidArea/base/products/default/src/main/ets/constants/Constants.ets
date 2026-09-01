/*
 * Copyright (c) 2025 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 ("the License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export interface Route {
  title: ResourceStr
  to: string
}
;

export const ROUTES: Route[] = [
  {
    title: $r('app.string.router_title_background'),
    to: 'Shopping'
  },
  {
    title: $r('app.string.full_screen_title'),
    to: 'FullScreen'
  },
  {
    title: $r('app.string.cutout_title'),
    to: 'Cutout'
  },
  {
    title: $r('app.string.swiper_list_title'),
    to: 'SwiperList'
  },
];

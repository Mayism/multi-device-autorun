/*
 * Copyright (c) 2025 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
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

import 'package:flutter/material.dart';

class AppThemes {
  static final ThemeData lightTheme = ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    // 亮色模式
    primarySwatch: Colors.blue,
    primaryColor: Colors.black,
    cardColor: Colors.white,
    scaffoldBackgroundColor: const Color(0xFFf1f3f5),
    visualDensity: VisualDensity.adaptivePlatformDensity,
  );

  static final ThemeData darkTheme = ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    // 暗色模式
    primaryColor: Colors.white,
    cardColor: const Color(0xFF333333),
    scaffoldBackgroundColor: const Color(0xFF000000),
    visualDensity: VisualDensity.adaptivePlatformDensity,
  );
}

import mockAdapter from '../common/MockAdapter';
import { VideoServiceMock } from '../httpsmock/VideoServiceMock';

// todo: 全局配置，是否启用mock，默认启用
const enableMock: boolean = true;

if (enableMock) {
  const mockApis = [
    new VideoServiceMock(),
  ];
  mockApis.forEach((api) => {
    api.start(mockAdapter);
  });
}


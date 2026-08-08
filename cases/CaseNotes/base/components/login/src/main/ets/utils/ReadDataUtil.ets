import { buffer } from '@kit.ArkTS';

/**
 * 从rawfile文件夹下读取数据
 * @param fileName
 * @param key
 * @returns
 */
export function readDataFromRawFile<T>(uiContext:UIContext, fileName: string, key: string): T | undefined {
  try {
    // Read data from rawfile.
    const value: Uint8Array = (uiContext.getHostContext() as Context).resourceManager.getRawFileContentSync(fileName);
    // return result
    return JSON.parse(buffer.from(value.buffer).toString())[key] as T;
  } catch (error) {
    return undefined;
  }
}

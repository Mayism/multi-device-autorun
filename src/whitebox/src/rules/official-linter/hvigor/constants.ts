// 保留命令尾部输出即可定位失败，同时避免把超长日志写入结果文件。
export const stdoutExcerptBytes = 64 * 1024;
export const stderrExcerptBytes = 16 * 1024;

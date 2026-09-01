import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import { RemoteEvaluationTask, RemoteTaskFileManifest } from "../../types.js";
import { fetchWithNetworkLogging } from "./networkLogger.js";

export type RemoteDownloadLogger = {
  info(message: string): Promise<void>;
  error(message: string): Promise<void>;
};

type RemoteDownloadOptions = {
  label?: string;
  logger?: RemoteDownloadLogger;
};

function formatRemoteDownloadContext(url: string, options?: RemoteDownloadOptions): string {
  return `label=${options?.label ?? "remote_resource"} url=${url}`;
}

function formatRemoteDownloadLog(
  url: string,
  options: RemoteDownloadOptions | undefined,
  message: string,
): string {
  const [event, ...details] = message.split(" ");
  return [event, formatRemoteDownloadContext(url, options), ...details].join(" ");
}

async function logRemoteDownloadInfo(
  url: string,
  options: RemoteDownloadOptions | undefined,
  message: string,
): Promise<void> {
  await options?.logger?.info(formatRemoteDownloadLog(url, options, message));
}

async function logRemoteDownloadError(
  url: string,
  options: RemoteDownloadOptions | undefined,
  message: string,
): Promise<void> {
  await options?.logger?.error(formatRemoteDownloadLog(url, options, message));
}

export async function downloadToFile(
  url: string,
  outputPath: string,
  options?: RemoteDownloadOptions,
): Promise<string> {
  const startedAt = Date.now();
  await logRemoteDownloadInfo(url, options, "remote_download_started");
  try {
    const res = await fetchWithNetworkLogging(url);
    await logRemoteDownloadInfo(
      url,
      options,
      `remote_download_response status=${res.status} ok=${String(res.ok)} elapsedMs=${String(Date.now() - startedAt)}`,
    );
    if (!res.ok) {
      throw new Error(`Failed to download ${url}: ${res.status}`);
    }
    const text = await res.text();
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, text, "utf-8");
    await logRemoteDownloadInfo(
      url,
      options,
      `remote_download_completed bytes=${String(Buffer.byteLength(text, "utf-8"))} elapsedMs=${String(Date.now() - startedAt)}`,
    );
    return outputPath;
  } catch (error) {
    await logRemoteDownloadError(
      url,
      options,
      `remote_download_failed error=${error instanceof Error ? error.message : String(error)} elapsedMs=${String(Date.now() - startedAt)}`,
    );
    throw error;
  }
}

export async function downloadJson<T>(url: string): Promise<T> {
  const response = await fetchWithNetworkLogging(url);
  if (!response.ok) {
    throw new Error(`Failed to download JSON ${url}: ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function downloadRemoteTask(url: string): Promise<RemoteEvaluationTask> {
  return downloadJson<RemoteEvaluationTask>(url);
}

function parseManifest(url: string, sourceText: string): RemoteTaskFileManifest {
  const manifest = JSON.parse(sourceText) as RemoteTaskFileManifest;
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`Invalid remote manifest from ${url}: files must be a non-empty array`);
  }
  return manifest;
}

async function writeManifestToDirectory(
  url: string,
  outputDir: string,
  manifest: RemoteTaskFileManifest,
): Promise<string[]> {
  const writtenFiles: string[] = [];
  for (const file of manifest.files) {
    if (typeof file?.path !== "string" || file.path.length === 0) {
      throw new Error(`Invalid remote manifest from ${url}: file.path is required`);
    }
    if (typeof file?.content !== "string") {
      throw new Error(`Invalid remote manifest from ${url}: file.content must be a string`);
    }

    const targetPath = path.join(outputDir, file.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf-8");
    writtenFiles.push(targetPath);
  }

  return writtenFiles;
}

function isZipPayload(url: string, contentType: string | null, bytes: Uint8Array): boolean {
  const loweredType = contentType?.toLowerCase() ?? "";
  const lowerUrl = url.toLowerCase();
  const hasZipMagic =
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(bytes[2] ?? -1) &&
    [0x04, 0x06, 0x08].includes(bytes[3] ?? -1);

  return loweredType.includes("zip") || lowerUrl.endsWith(".zip") || hasZipMagic;
}

function normalizeZipEntryPath(url: string, entry: string): string {
  const normalized = path.posix.normalize(entry.replace(/\\/g, "/"));
  if (
    normalized.length === 0 ||
    normalized === "." ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Remote archive from ${url} contains an unsafe entry: ${entry}`);
  }
  return normalized;
}

function openZipFromBuffer(bytes: Uint8Array): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, strictFileNames: false },
      (error, zipfile) => {
        if (error) {
          reject(error);
          return;
        }
        if (!zipfile) {
          reject(new Error("Failed to open remote archive: zipfile is unavailable"));
          return;
        }
        resolve(zipfile);
      },
    );
  });
}

function openZipEntryStream(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stream);
    });
  });
}

async function extractZipToDirectory(
  url: string,
  outputDir: string,
  archiveBytes: Uint8Array,
): Promise<string[]> {
  const zipfile = await openZipFromBuffer(archiveBytes);
  const writtenFiles: string[] = [];

  await fs.mkdir(outputDir, { recursive: true });

  return new Promise((resolve, reject) => {
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      zipfile.close();
      reject(error);
    };

    zipfile.on("error", fail);
    zipfile.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      zipfile.close();
      if (writtenFiles.length === 0) {
        reject(new Error(`Remote archive from ${url} does not contain any files`));
        return;
      }
      resolve(writtenFiles);
    });

    zipfile.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        const entryPath = normalizeZipEntryPath(url, entry.fileName);
        const isDirectory = entry.fileName.replace(/\\/g, "/").endsWith("/");
        const targetPath = path.join(outputDir, ...entryPath.split("/"));

        if (isDirectory) {
          await fs.mkdir(targetPath, { recursive: true });
          zipfile.readEntry();
          return;
        }

        const stream = await openZipEntryStream(zipfile, entry);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await pipeline(stream, createWriteStream(targetPath));
        writtenFiles.push(targetPath);
        zipfile.readEntry();
      })().catch(fail);
    });

    zipfile.readEntry();
  });
}

export async function downloadManifestToDirectory(
  url: string,
  outputDir: string,
  options?: RemoteDownloadOptions,
): Promise<string[]> {
  const startedAt = Date.now();
  await logRemoteDownloadInfo(url, options, "remote_download_started");
  try {
    const response = await fetchWithNetworkLogging(url);
    await logRemoteDownloadInfo(
      url,
      options,
      `remote_download_response status=${response.status} ok=${String(response.ok)} elapsedMs=${String(Date.now() - startedAt)}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to download remote project ${url}: ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const writtenFiles = isZipPayload(url, response.headers.get("Content-Type"), bytes)
      ? await extractZipToDirectory(url, outputDir, bytes)
      : await writeManifestToDirectory(
          url,
          outputDir,
          parseManifest(url, new TextDecoder("utf-8").decode(bytes)),
        );
    await logRemoteDownloadInfo(
      url,
      options,
      `remote_download_completed bytes=${String(bytes.byteLength)} fileCount=${String(writtenFiles.length)} elapsedMs=${String(Date.now() - startedAt)}`,
    );
    return writtenFiles;
  } catch (error) {
    await logRemoteDownloadError(
      url,
      options,
      `remote_download_failed error=${error instanceof Error ? error.message : String(error)} elapsedMs=${String(Date.now() - startedAt)}`,
    );
    throw error;
  }
}

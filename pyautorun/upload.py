"""ZIP all case artifacts and optionally upload failed cases to AGC storage."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import uuid4

from .archive import create_zip
from .case_run import write_json
from .batch_state import read_json


TOKEN_URL = "https://connect-api.cloud.huawei.com/api/oauth2/v1/token"
UPLOAD_HOSTS = {"CN": "https://ops-server-drcn.agcstorage.link",
                "RU": "https://ops-server-drru.agcstorage.link",
                "SG": "https://ops-server-dra.agcstorage.link",
                "DE": "https://ops-server-dre.agcstorage.link"}
DOWNLOAD_HOSTS = {"CN": "https://agc-storage-drcn.platform.dbankcloud.cn",
                  "RU": "https://agc-storage-drru.platform.dbankcloud.cn",
                  "SG": "https://agc-storage-dra.platform.dbankcloud.cn",
                  "DE": "https://agc-storage-dre.platform.dbankcloud.cn"}


def upload_config(raw):
    raw = raw or {}
    config = {"enabled": raw.get("enabled") is True,
              "projectId": str(raw.get("projectId") or os.environ.get("AGC_UPLOAD_PROJECT_ID") or ""),
              "clientId": str(raw.get("clientId") or os.environ.get("AGC_UPLOAD_CLIENT_ID") or ""),
              "clientSecret": str(raw.get("clientSecret") or os.environ.get("AGC_UPLOAD_CLIENT_SECRET") or ""),
              "bucketName": str(raw.get("bucketName") or os.environ.get("AGC_UPLOAD_BUCKET") or ""),
              "region": str(raw.get("region") or os.environ.get("AGC_UPLOAD_REGION") or "CN").upper(),
              "prefix": str(raw.get("prefix") or "ohostest"),
              "maxRetries": max(1, int(raw.get("maxRetries") or 3))}
    if config["enabled"]:
        missing = [name for name in ("projectId", "clientId", "clientSecret", "bucketName") if not config[name]]
        if missing:
            raise ValueError("upload.enabled=true 时缺少 AGC 上传配置: " + ", ".join(missing))
    return config


class AgcStorageUploader:
    def __init__(self, config):
        self.config = config
        self.token = ""
        self.expires_at = 0

    def _access_token(self):
        if self.token and time.time() < self.expires_at:
            return self.token
        body = json.dumps({"grant_type": "client_credentials", "client_id": self.config["clientId"],
                           "client_secret": self.config["clientSecret"]}).encode()
        with urlopen(Request(TOKEN_URL, data=body, headers={"Content-Type": "application/json"}, method="POST"),
                     timeout=30) as response:
            data = json.load(response)
        if not data.get("access_token"):
            raise ValueError("OAuth2 响应缺少 access_token")
        self.token = data["access_token"]
        self.expires_at = time.time() + max(int(data.get("expires_in") or 3600) - 60, 60)
        return self.token

    def upload(self, content, object_name, on_log=lambda _message: None):
        config = self.config
        region = config["region"] if config["region"] in UPLOAD_HOSTS else "CN"
        encoded = quote(object_name, safe="/")
        upload_url = f"{UPLOAD_HOSTS[region]}/v0/{config['bucketName']}/{encoded}"
        last_error = None
        for attempt in range(1, config["maxRetries"] + 1):
            try:
                request = Request(upload_url, data=content, method="PUT",
                                  headers={"Authorization": "Bearer " + self._access_token(),
                                           "Content-Type": "application/zip", "Content-Length": str(len(content)),
                                           "X-Agc-File-Size": str(len(content)), "X-Agc-Trace-Id": uuid4().hex,
                                           "client_id": config["clientId"], "productId": config["projectId"]})
                with urlopen(request, timeout=180) as response:
                    try:
                        data = json.load(response)
                    except ValueError:
                        data = {}
                base = f"{DOWNLOAD_HOSTS[region]}/v0/{config['bucketName']}/{quote(object_name, safe='')}"
                share = data.get("share_token") or data.get("token") or ""
                url = data.get("shared_download_url") or data.get("download_url") or \
                    (base + "?token=" + quote(share) if share else base)
                on_log(f"上传成功（第 {attempt} 次）: {object_name}")
                return {"url": url, "objectName": object_name, "attempt": attempt}
            except Exception as error:
                last_error = error
                on_log(f"上传失败（第 {attempt}/{config['maxRetries']} 次）: {error}")
                if attempt < config["maxRetries"]:
                    time.sleep(attempt)
        raise RuntimeError(f"上传失败（重试 {config['maxRetries']} 次）: {last_error}")


def case_needs_upload(result, ohos):
    status = str(result.get("status") or "").lower()
    if status and status not in ("completed", "skipped", "cancelled"):
        return True
    run = (ohos or {}).get("run") or {}
    return any((device.get("failures") or 0) > 0 or (device.get("errors") or 0) > 0
               for device in run.get("devices") or [])


def archive_and_upload(batch_root, summary, report, raw_config=None, on_log=lambda _message: None,
                       uploader=None):
    root = Path(batch_root)
    config = upload_config(raw_config)
    uploader = uploader or (AgcStorageUploader(config) if config["enabled"] else None)
    results_path = root / "upload-results.json"
    existing = read_json(results_path) or {}
    results = dict(existing)
    ohos_by_case = {item["case"]: item for item in (report.get("ohosTest") or {}).get("caseResults") or []}
    for result in summary.get("results") or []:
        name = result.get("case")
        if not name:
            continue
        case_dir = root / name
        if not case_dir.is_dir():
            on_log(f"{name}: 用例目录不存在，跳过")
            continue
        filename = f"{name}_{summary.get('batchId') or root.name}.zip"
        local = case_dir / filename
        try:
            content = create_zip({"sources": [{"dirPath": str(case_dir), "prefix": ""}],
                                  "excludeAbsPaths": [str(local)]})
            local.write_bytes(content)
            on_log(f"{name}: 已保存本地 ZIP: {local}")
            if config["enabled"] and not existing.get(name, {}).get("url") and \
                    case_needs_upload(result, ohos_by_case.get(name)):
                object_name = f"{config['prefix']}/{filename}"
                uploaded = uploader.upload(content, object_name, on_log)
                results[name] = {"url": uploaded["url"], "error": "",
                                 "uploadedAt": datetime.now(timezone.utc).isoformat()}
        except Exception as error:
            old = results.get(name) or {}
            results[name] = {**old, "url": old.get("url") or "", "error": str(error),
                             "uploadedAt": datetime.now(timezone.utc).isoformat()}
            on_log(f"{name}: 打包/上传失败: {error}")
        write_json(results_path, results)
    return results

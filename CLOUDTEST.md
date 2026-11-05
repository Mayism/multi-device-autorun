## 链路

# ============================================================
# AGC 云测试 L2 检测接口调用参考
# 代码路径：harmony_eval/plugins/cloud/
# Base URL: https://connect-api.cloud.huawei.com
# ============================================================

# ------------------------------------------------------------
# 0. 鉴权：Service Account JWT（PS256）
# 模块：detection_auth.py
# 凭证：config/service-account.json
# ------------------------------------------------------------
authentication:
  method: JWT_PS256
  credential_file: config/service-account.json
  credential_file_schema:
    key_id: "AGC 控制台下载的凭证 key_id"
    private_key: "PEM 格式私钥字符串"
    sub_account: "子账号，用于 JWT payload.iss"
    token_uri: "https://oauth-login.cloud.huawei.com/oauth2/v3/token"
  jwt_header:
    kid: "{credential.key_id}"
    typ: JWT
    alg: PS256
  jwt_payload:
    iss: "{credential.sub_account}"
    sub: "{credential.sub_account}"
    aud: "{credential.token_uri}"
    iat: "{当前时间戳}"
    exp: "{iat + 3600}"
  signature: "PSS(MGF1(SHA256), salt=SHA256.digest_size) + SHA256"
  auth_header: "Bearer {jwt}"
  validity: "3600 秒，过期前 60 秒自动刷新"

# ------------------------------------------------------------
# 1. 获取 OBS 上传地址
# 模块：detection_upload.py:request_upload_url()
# ------------------------------------------------------------
upload_url:
  method: GET
  path: /api/publish/v2/upload-url/for-obs
  headers:
    Authorization: "Bearer {jwt}"
  query_params:
    appId: "{settings.appId}  # task.yaml cloudTest.appId"
    fileName: "{hap文件名}.app  # 如 xxx-signed.app"
    contentLength: "{文件字节数}"
    sha256: "{文件SHA256十六进制}"
  response:
    urlInfo:
      url: "OBS 预签名上传地址"
      headers: "OBS 签名请求头（原样透传 PUT）"
      objectId: "OBS 对象 ID"

# ------------------------------------------------------------
# 2. 上传 App 包到 OBS
# 模块：detection_upload.py:put_object()
# ------------------------------------------------------------
upload_app:
  method: PUT
  url: "{urlInfo.url}  # 上一步返回的 OBS 地址"
  headers: "{urlInfo.headers}  # 原样透传；过滤掉 connection/host/content-length/keep-alive 等"
  body: "二进制 .app/.hap 文件流"
  timeout: 300s
  response: "HTTP 200（无业务 JSON）"

# ------------------------------------------------------------
# 3. 创建检测任务
# 模块：detection_client.py:create_task()
# ------------------------------------------------------------
create_task:
  method: POST
  path: /api/ci-product/v1/detection/task
  headers:
    Authorization: "Bearer {jwt}"
    teamId: "{settings.teamId}"
    Content-Type: application/json
  body:
    appId: "{settings.appId}"
    packageName: "{settings.bundleName}  # task.yaml cloudTest.bundleName"
    objectId: "{OBS objectId}"
    fileName: "{hap文件名.app}"
    source: CI_CD_TOOL
    categories:
      - category: UX                    # ← task.yaml test_category 解析
      - category: COMPATIBILITY
      # 合法枚举: COMPATIBILITY / UX / PERFORMANCE / STABILITY / POWER_CONSUMPTION
    extendField: null
  response:
    taskId: "{平台分配的检测任务 ID}"

# ------------------------------------------------------------
# 4. 查询检测任务报告（轮询）
# 模块：detection_client.py:query_task_report()
# ------------------------------------------------------------
query_report:
  method: GET
  path: /api/ci-product/v1/detection/task/report
  headers:
    Authorization: "Bearer {jwt}"
    teamId: "{settings.teamId}"
  query_params:
    taskId: "{taskId}"
  response:
    status: detected | exception | timeout
    reportUrl: "在线报告地址"
    offlineReport:
      status: 0 | 1        # 1=生成中，0=就绪
  polling:
    interval: "{settings.pollIntervalSec，默认60秒}"
    timeout: "{settings.taskTimeoutSec，默认7200秒}"

# ------------------------------------------------------------
# 5. 停止任务（可选，中断时调用）
# 模块：detection_client.py:stop_task()
# ------------------------------------------------------------
stop_task:
  method: PUT
  path: /api/ci-product/v1/detection/task
  headers:
    Authorization: "Bearer {jwt}"
    teamId: "{settings.teamId}"
  query_params:
    taskId: "{taskId}"
    type: stop

# ------------------------------------------------------------
# 6. 离线报告处理（非 HTTP 接口，本地 ZIP 解析）
# 模块：detection_report.py + l2_scoring.py
# ------------------------------------------------------------
offline_report_processing:
  download: "下载 reportUrl 对应的 ZIP"
  extract: "解压出 data/{categoryId}/statisticsDetail.js|taskList.js|overviewProblem.js 等"
  parse_zip:
    output_structured:
      categoryResults:                      # L2 评分主要数据源
        - category: "{categoryId 数字ID}"
          ruleInfo:
            totalErrorCount: "{规则总数}"
            passedErrorCount: "{通过规则数}"
            failedErrorCount: "{失败规则数}"
      categories:
        - categoryId: "数字ID"
          tasks:
            - result:
                taskCategory: "UX/COMPATIBILITY/..."  # 用于反推 ID→名称映射
      tasks:
        - reportId: "..."
          result: "{检测详情}"
          appInfo: "{应用信息}"
          deviceInfo: "{设备信息}"

# ------------------------------------------------------------
# 7. L2 评分计算（本地）
# 模块：l2_scoring.py:build_l2_cloud_score()
# ------------------------------------------------------------
l2_scoring:
  category_id_to_name_map:       # 硬编码默认值
    COMPATIBILITY: 1
    STABILITY: 2
    POWER_CONSUMPTION: 3
    PERFORMANCE: 10
    UX: 24
  dimension_weights:             # L2_DIMENSIONS
    基础质量: 0.5
    合规可信: 0.1
    安全隐私: 0.2
    极致体验: 0.2
  cloudTest_covered_items:       # 只有这些从云测试取数
    基础质量: [UX基础体验(UX), 功耗(POWER_CONSUMPTION), 稳定性(STABILITY), 兼容性(COMPATIBILITY)]
    极致体验: [性能(PERFORMANCE)]
  formula:
    item_score: "passedErrorCount / totalErrorCount × 100"
    dimension_score: "Σpassed / Σtotal × 100"
    normalized_weight: "dim.weight / Σ(evaluated dim.weight)"
    weighted_score: "dimension_score × normalized_weight"
    total: "Σ weighted_score"
  output:
    l2CloudScore:
      itemScores:
        - dimension: 基础质量
          item: UX基础体验
          category: UX
          categoryId: 24
          totalRules: 10
          passedRules: 8
          failedRules: 2
          score: 80.0
          evaluated: true
      dimensionScores:
        - dimension: 基础质量
          weight: 0.5
          normalizedWeight: 0.7143
          totalRules: 20
          passedRules: 16
          failedRules: 4
          dimensionScore: 80.0
          weightedScore: 57.143
          evaluated: true
      totalWeightedScore: 68.571
      note: "未检测维度权重剔除后归一"

# ------------------------------------------------------------
# 最终落盘
# ------------------------------------------------------------
persist:
  path: "{out_dir}/cloudtest-result.json"
  schema:
    schemaVersion: detection-run-v1
    status: completed | failed | interrupted
    task:
      taskId: "..."
      taskName: "..."
    report:
      reportUrl: "..."
      l2CloudScore: "{见上}"
      summary: "..."
      htmlPath: "本地报告 index.html"
      reportDir: "解压目录"
    outputDir: "..."
    startedAt: "..."
    finishedAt: "..."
    error: ""

## 配置
verification:
  - type: CloudTest
    test_category: COMPATIBILITY,UX    # → categories 数组
    bundleName: com.huawei.EvaluationPlatform    # → create_task.packageName
    proxy: http://user:pass@proxy:8080            # → 所有请求走 HTTP 代理
    teamId: "2850086000419221590"                 # → 所有请求 header teamId
    appId: "6917617693037593641"                  # → upload-url + create_task
    signingConfigs:                                # → 本地构建签名（不传接口）
      - name: default
        material:
          storeFile: config/signing/test.p12
          profile: config/signing/test.p7b
          certpath: config/signing/test.cer
          storePassword: "<加密密码>"
          keyAlias: yl
          keyPassword: "<加密密码>"
          signAlg: SHA256withECDSA

## 接口配置
base_url: https://connect-api.cloud.huawei.com   # cloudtest.py:59 默认值，可被 detection.baseUrl 覆盖

# 完整接口 URL
upload_url:
  full_url: https://connect-api.cloud.huawei.com/api/publish/v2/upload-url/for-obs?appId={appId}&fileName={fileName}&contentLength={size}&sha256={sha256}
  # detection_upload.py:22 — GET + query

create_task:
  full_url: https://connect-api.cloud.huawei.com/api/ci-product/v1/detection/task
  # detection_client.py:53 — POST + JSON body

query_report:
  full_url: https://connect-api.cloud.huawei.com/api/ci-product/v1/detection/task/report?taskId={taskId}
  # detection_client.py:61 — GET + query

stop_task:
  full_url: https://connect-api.cloud.huawei.com/api/ci-product/v1/detection/task?taskId={taskId}&type=stop
  # detection_client.py:65 — PUT + query

upload_obs:
  full_url: "{upload_url 接口返回的 urlInfo.url}"   # 动态 OBS 预签名地址，非固定

url = self.base_url + API_PREFIX + pathname   # API_PREFIX = "/api/ci-product/v1/detection"
    

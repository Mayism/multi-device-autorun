export type ApiMethod = "GET" | "POST" | "PUT" | "DELETE" | "OPTIONS";

export type ApiSchemaPrimitive = "boolean" | "number" | "string" | "object" | "array" | "unknown";

export type ApiFieldSchema = {
  type: ApiSchemaPrimitive | "enum";
  description: string;
  required?: boolean;
  values?: readonly string[];
  properties?: ApiSchemaProperties;
  items?: ApiFieldSchema;
  example?: unknown;
};

export type ApiSchemaProperties = Record<string, ApiFieldSchema>;

export type ApiObjectSchema = {
  type: "object";
  description: string;
  properties: ApiSchemaProperties;
  example?: Record<string, unknown>;
};

export type ApiRequestDefinition = {
  pathParams?: ApiSchemaProperties;
  headers?: ApiSchemaProperties;
  body?: ApiObjectSchema;
};

export type ApiResponseDefinition = {
  status: number;
  description: string;
  body: ApiObjectSchema;
};

export type ApiCallbackDefinition = {
  name: string;
  method: ApiMethod;
  urlSource: string;
  description: string;
  headers?: ApiSchemaProperties;
  body: ApiObjectSchema;
};

export type ApiDefinition = {
  method: ApiMethod;
  path: string;
  description: string;
  request?: ApiRequestDefinition;
  responses: ApiResponseDefinition[];
  callbacks?: ApiCallbackDefinition[];
};

export const API_PATHS = {
  health: "/health",
  runRemoteTask: "/score/run-remote-task",
  remoteTasks: "/score/remote-tasks",
  remoteTaskResult: "/score/remote-tasks/:taskId/result",
  remoteTaskRawResult: "/score/remote-tasks/:taskId/result/raw",
  remoteTaskStatuses: "/score/remote-tasks/status",
  consistencyTasks: "/score/consistency-tasks",
  consistencyTask: "/score/consistency-tasks/:id",
  ruleViolationStats: "/score/rule-violation-stats",
  humanReview: "/score/remote-tasks/:taskId/human-review",
  dashboardSummary: "/dashboard/summary",
  dashboardTasks: "/dashboard/tasks",
  dashboardTaskLogs: "/dashboard/tasks/:taskId/logs",
  dashboardTaskAgentTrace: "/dashboard/tasks/:taskId/agent-trace",
  dashboardTaskAgentTraceRunRaw: "/dashboard/tasks/:taskId/agent-trace/runs/:traceRunId/raw",
  dashboardTaskAgentTraceEventRaw: "/dashboard/tasks/:taskId/agent-trace/events/:traceEventId/raw",
  dashboardTaskStatusCounts: "/dashboard/tasks/status-counts",
  dashboardAnalysisHumanRatingGaps: "/dashboard/analysis/human-rating-gaps",
  dashboardAnalysisHumanRatingGapManualStatus:
    "/dashboard/analysis/human-rating-gaps/manual-analysis-status",
  dashboardAnalysisRiskReviewCalibrations: "/dashboard/analysis/risk-review-calibrations",
  dashboardAnalysisRiskReviewManualStatus:
    "/dashboard/analysis/risk-review-calibrations/manual-analysis-status",
  dashboardAnalysisNegativeResults: "/dashboard/analysis/negative-results",
  dashboardCrossDeviceCases: "/dashboard/cross-device/cases",
  dashboardCrossDeviceRuleViolations: "/dashboard/cross-device/rule-violations",
  dashboardCrossDeviceRiskReviewCalibrations: "/dashboard/cross-device/risk-review-calibrations",
} as const;

const successField = {
  type: "boolean",
  required: true,
  description: "Whether the request was handled successfully.",
} as const satisfies ApiFieldSchema;

const messageField = {
  type: "string",
  required: true,
  description: "Human-readable result or error message.",
} as const satisfies ApiFieldSchema;

const taskIdField = {
  type: "number",
  required: true,
  description: "Remote evaluation task id.",
} as const satisfies ApiFieldSchema;

const statusField = {
  type: "enum",
  required: true,
  values: ["pending", "running", "completed", "failed"],
  description: "Remote evaluation callback status.",
} as const satisfies ApiFieldSchema;

const remoteTaskRecordStatusField = {
  type: "enum",
  required: false,
  values: ["preparing", "queued", "running", "completed", "failed", "timed_out", "missing"],
  description: "Internal remote task execution status recorded by this service.",
} as const satisfies ApiFieldSchema;

const errorResponseBody = {
  type: "object",
  description: "Common failure response body.",
  properties: {
    success: successField,
    message: messageField,
  },
} as const satisfies ApiObjectSchema;

const remoteTestCaseSchema = {
  type: "object",
  required: true,
  description: "Remote test case metadata and original project manifest URL.",
  properties: {
    id: { type: "number", required: true, description: "Remote test case id." },
    name: { type: "string", required: true, description: "Remote test case name." },
    type: { type: "string", required: true, description: "Remote test case type." },
    description: { type: "string", required: true, description: "Requirement description." },
    input: { type: "string", required: true, description: "Original task input prompt." },
    expectedOutput: {
      type: "string",
      required: true,
      description: "Expected output description from remote platform.",
    },
    fileUrl: {
      type: "string",
      required: true,
      description: "URL of original project file manifest JSON.",
    },
  },
} as const satisfies ApiFieldSchema;

const remoteExecutionResultSchema = {
  type: "object",
  required: true,
  description: "Submitted execution result and generated project artifact URLs.",
  properties: {
    isBuildSuccess: {
      type: "boolean",
      required: true,
      description: "Whether the submitted project build succeeded remotely.",
    },
    outputCodeUrl: {
      type: "string",
      required: true,
      description: "URL of generated project file manifest JSON.",
    },
    diffFileUrl: {
      type: "string",
      required: false,
      description:
        "Deprecated compatibility field. The service ignores this value and generates patches from original/output code.",
    },
  },
} as const satisfies ApiFieldSchema;

const resultDataField = {
  type: "object",
  required: false,
  description:
    "Completed callback result subset containing only basic_info and overall_conclusion. Full scoring result JSON is available from the result API.",
} as const satisfies ApiFieldSchema;

const consistencyTaskItemsField = {
  type: "array",
  required: true,
  description:
    "Persisted score consistency task records. Each record is the dashboard task collection item.",
  items: {
    type: "object",
    description: "One score consistency task record.",
  },
} as const satisfies ApiFieldSchema;

const consistencyTaskItemField = {
  type: "object",
  required: true,
  description: "One persisted score consistency task record.",
  properties: {},
} as const satisfies ApiFieldSchema;

const consistencyTaskPatchField = {
  type: "object",
  required: true,
  description:
    "Small consistency task patch. Runs are merged by taskId and analysisHistory entries are appended by round/capturedAt.",
  properties: {
    status: {
      type: "string",
      required: false,
      description: "Updated consistency task status.",
    },
    replaceRuns: {
      type: "boolean",
      required: false,
      description: "When true, replace the current run list instead of merging by taskId.",
    },
    runs: {
      type: "array",
      required: false,
      description: "Changed run summaries only.",
      items: {
        type: "object",
        description: "One changed consistency run summary.",
      },
    },
    analysisHistory: {
      type: "array",
      required: false,
      description: "Newly appended history snapshots only.",
      items: {
        type: "object",
        description: "One appended consistency analysis history snapshot.",
      },
    },
  },
} as const satisfies ApiFieldSchema;

const remoteCallbackDefinition = {
  name: "remoteTaskCallback",
  method: "POST",
  urlSource: "request.body.callback",
  description:
    "Callback sent to the remote platform while executing an accepted remote task. Queued tasks receive an early pending callback before an execution slot is available.",
  body: {
    type: "object",
    description: "Remote task callback payload produced by this service.",
    properties: {
      success: {
        type: "boolean",
        required: false,
        description: "True for completed callbacks.",
      },
      taskId: taskIdField,
      status: statusField,
      totalScore: {
        type: "number",
        required: false,
        description: "Final score. Present for completed callbacks.",
      },
      maxScore: {
        type: "number",
        required: false,
        description: "Maximum score. Present with totalScore.",
      },
      resultData: resultDataField,
      errorMessage: {
        type: "string",
        required: false,
        description: "Failure message. Present for failed callbacks.",
      },
    },
  },
} as const satisfies ApiCallbackDefinition;

export const API_DEFINITIONS: ApiDefinition[] = [
  {
    method: "GET",
    path: API_PATHS.health,
    description: "Service health check.",
    responses: [
      {
        status: 200,
        description: "Service is running.",
        body: {
          type: "object",
          description: "Health check response.",
          properties: {
            ok: { type: "boolean", required: true, description: "Always true when service is up." },
          },
          example: { ok: true },
        },
      },
    ],
  },
  {
    method: "POST",
    path: API_PATHS.runRemoteTask,
    description: "Accept one remote evaluation task and execute it asynchronously.",
    request: {
      body: {
        type: "object",
        description: "Remote evaluation task request body.",
        properties: {
          taskId: taskIdField,
          testCase: remoteTestCaseSchema,
          executionResult: remoteExecutionResultSchema,
          token: {
            type: "string",
            required: false,
            description: "Deprecated. This service no longer requires or echoes callback tokens.",
          },
          callback: {
            type: "string",
            required: true,
            description: "Callback URL to receive remote task progress and final result payloads.",
          },
        },
      },
    },
    responses: [
      {
        status: 200,
        description: "Remote task accepted and queued for asynchronous execution.",
        body: {
          type: "object",
          description: "Remote task acceptance response.",
          properties: {
            success: successField,
            taskId: taskIdField,
            message: messageField,
          },
          example: {
            success: true,
            taskId: 4,
            message: "任务接收成功，结果将通过 callback 返回",
          },
        },
      },
      { status: 500, description: "Remote task acceptance failed.", body: errorResponseBody },
    ],
    callbacks: [remoteCallbackDefinition],
  },
  {
    method: "GET",
    path: API_PATHS.ruleViolationStats,
    description: "Read aggregated static rule violation statistics.",
    responses: [
      {
        status: 200,
        description: "Static rule violation statistics.",
        body: {
          type: "object",
          description: "Rules-only static violation stats response.",
          properties: {
            success: successField,
            filters: {
              type: "object",
              required: true,
              description: "Applied query filters.",
            },
            summary: {
              type: "object",
              required: true,
              description: "Aggregate run and violation counts.",
            },
            rules: {
              type: "array",
              required: true,
              description: "Aggregated static rule violation rows. No cases summary is returned.",
              items: {
                type: "object",
                description: "One static rule violation aggregate.",
              },
            },
          },
        },
      },
      { status: 400, description: "Invalid query parameter.", body: errorResponseBody },
      { status: 500, description: "Stats index could not be read.", body: errorResponseBody },
    ],
  },
  {
    method: "GET",
    path: API_PATHS.remoteTaskResult,
    description: "Read the completed remote task result JSON as resultData.",
    request: {
      pathParams: {
        taskId: taskIdField,
      },
    },
    responses: [
      {
        status: 200,
        description: "Completed remote task result is available.",
        body: {
          type: "object",
          description: "Remote task result response.",
          properties: {
            success: successField,
            taskId: taskIdField,
            status: remoteTaskRecordStatusField,
            resultData: {
              type: "object",
              required: true,
              description: "Parsed outputs/result.json content for the completed task.",
            },
          },
        },
      },
      {
        status: 404,
        description: "Task record or result file was not found.",
        body: {
          type: "object",
          description: "Remote task not found response.",
          properties: {
            success: successField,
            taskId: { ...taskIdField, required: false },
            status: remoteTaskRecordStatusField,
            message: messageField,
          },
        },
      },
      {
        status: 409,
        description: "Task exists but has not completed yet.",
        body: {
          type: "object",
          description: "Remote task result unavailable response.",
          properties: {
            success: successField,
            taskId: taskIdField,
            status: remoteTaskRecordStatusField,
            message: messageField,
          },
        },
      },
    ],
  },
  {
    method: "GET",
    path: API_PATHS.remoteTaskRawResult,
    description: "Download the exact stored outputs/result.json file for a completed remote task.",
    request: {
      pathParams: {
        taskId: taskIdField,
      },
    },
    responses: [
      {
        status: 200,
        description: "Raw result.json file is available as an attachment.",
        body: {
          type: "object",
          description: "Raw JSON file response body.",
          properties: {},
        },
      },
      {
        status: 404,
        description: "Task record or result file was not found.",
        body: {
          type: "object",
          description: "Remote task not found response.",
          properties: {
            success: successField,
            taskId: { ...taskIdField, required: false },
            status: remoteTaskRecordStatusField,
            message: messageField,
          },
        },
      },
      {
        status: 409,
        description: "Task exists but has not completed yet.",
        body: {
          type: "object",
          description: "Remote task result unavailable response.",
          properties: {
            success: successField,
            taskId: taskIdField,
            status: remoteTaskRecordStatusField,
            message: messageField,
          },
        },
      },
    ],
  },
  {
    method: "GET",
    path: API_PATHS.remoteTaskStatuses,
    description: "Read registry statuses for a batch of remote task ids.",
    request: {
      pathParams: {},
    },
    responses: [
      {
        status: 200,
        description: "Remote task statuses are available.",
        body: {
          type: "object",
          description: "Remote task status batch response.",
          properties: {
            success: successField,
            items: {
              type: "array",
              required: true,
              description: "Statuses in the same order as the requested taskIds query.",
              items: {
                type: "object",
                description: "One remote task status item.",
                properties: {
                  taskId: taskIdField,
                  status: remoteTaskRecordStatusField,
                  createdAt: {
                    type: "number",
                    required: false,
                    description: "Registry creation timestamp in milliseconds.",
                  },
                  updatedAt: {
                    type: "number",
                    required: false,
                    description: "Registry update timestamp in milliseconds.",
                  },
                  testCaseId: {
                    type: "number",
                    required: false,
                    description: "Remote test case id.",
                  },
                  testCaseName: {
                    type: "string",
                    required: false,
                    description: "Remote test case name.",
                  },
                  resultAvailable: {
                    type: "boolean",
                    required: true,
                    description: "Whether the completed result JSON can be requested.",
                  },
                  error: {
                    type: "string",
                    required: false,
                    description: "Recorded task error when available.",
                  },
                  message: {
                    type: "string",
                    required: false,
                    description: "Missing or diagnostic message.",
                  },
                },
              },
            },
          },
        },
      },
      { status: 400, description: "Invalid query parameter.", body: errorResponseBody },
    ],
  },
  {
    method: "DELETE",
    path: API_PATHS.remoteTasks,
    description: "Delete registry records for a batch of remote task ids.",
    responses: [
      {
        status: 200,
        description: "Remote task records were deleted when present.",
        body: {
          type: "object",
          description: "Remote task batch deletion response.",
          properties: {
            success: successField,
            deletedTaskIds: {
              type: "array",
              required: true,
              description: "Task ids that existed and were deleted.",
              items: taskIdField,
            },
          },
        },
      },
      { status: 400, description: "Invalid query parameter.", body: errorResponseBody },
    ],
  },
  {
    method: "GET",
    path: API_PATHS.consistencyTasks,
    description: "Read persisted score consistency task records.",
    responses: [
      {
        status: 200,
        description: "Persisted consistency tasks are available.",
        body: {
          type: "object",
          description: "Consistency task collection response.",
          properties: {
            success: successField,
            items: consistencyTaskItemsField,
          },
        },
      },
      { status: 500, description: "Consistency task table could not be read.", body: errorResponseBody },
    ],
  },
  {
    method: "PUT",
    path: API_PATHS.consistencyTasks,
    description:
      "Replace the persisted score consistency task table. The file is stored beside remote-task-index.json.",
    request: {
      body: {
        type: "object",
        description: "Consistency task collection replacement request.",
        properties: {
          items: consistencyTaskItemsField,
        },
      },
    },
    responses: [
      {
        status: 200,
        description: "Consistency task table was replaced.",
        body: {
          type: "object",
          description: "Consistency task collection response.",
          properties: {
            success: successField,
            items: consistencyTaskItemsField,
          },
        },
      },
      { status: 400, description: "Invalid consistency task records.", body: errorResponseBody },
      { status: 500, description: "Consistency task table could not be written.", body: errorResponseBody },
    ],
  },
  {
    method: "PUT",
    path: API_PATHS.consistencyTask,
    description: "Upsert one persisted score consistency task record.",
    request: {
      pathParams: {
        id: {
          type: "string",
          required: true,
          description: "Consistency task identifier.",
        },
      },
      body: consistencyTaskItemField,
    },
    responses: [
      {
        status: 200,
        description: "Consistency task record was upserted.",
        body: {
          type: "object",
          description: "Consistency task upsert response.",
          properties: {
            success: successField,
            item: consistencyTaskItemField,
          },
        },
      },
      { status: 400, description: "Invalid consistency task record.", body: errorResponseBody },
      { status: 500, description: "Consistency task table could not be written.", body: errorResponseBody },
    ],
  },
  {
    method: "POST",
    path: API_PATHS.consistencyTask,
    description: "Merge a small consistency task patch into one persisted record.",
    request: {
      pathParams: {
        id: {
          type: "string",
          required: true,
          description: "Consistency task identifier.",
        },
      },
      body: consistencyTaskPatchField,
    },
    responses: [
      {
        status: 200,
        description: "Consistency task patch was merged.",
        body: {
          type: "object",
          description: "Consistency task patch response.",
          properties: {
            success: successField,
            item: consistencyTaskItemField,
          },
        },
      },
      { status: 400, description: "Invalid consistency task patch.", body: errorResponseBody },
      { status: 404, description: "Consistency task was not found.", body: errorResponseBody },
      { status: 500, description: "Consistency task table could not be written.", body: errorResponseBody },
    ],
  },
  {
    method: "DELETE",
    path: API_PATHS.consistencyTask,
    description: "Delete one persisted score consistency task record by id.",
    request: {
      pathParams: {
        id: {
          type: "string",
          required: true,
          description: "Consistency task identifier.",
        },
      },
    },
    responses: [
      {
        status: 200,
        description: "Consistency task record was deleted.",
        body: {
          type: "object",
          description: "Consistency task deletion response.",
          properties: {
            success: successField,
          },
        },
      },
      {
        status: 400,
        description: "Invalid consistency task identifier.",
        body: errorResponseBody,
      },
      {
        status: 404,
        description: "Consistency task was not found.",
        body: errorResponseBody,
      },
      {
        status: 500,
        description: "Consistency task table could not be written.",
        body: errorResponseBody,
      },
    ],
  },
  {
    method: "POST",
    path: API_PATHS.humanReview,
    description:
      "Accept per-item human review results for a completed remote task. Repeated submissions overwrite the latest result revision.",
    request: {
      pathParams: { taskId: taskIdField },
      body: {
        type: "object",
        description: "Human review submission from the remote scoring console.",
        properties: {
          reviewer: {
            type: "string",
            required: false,
            description: "Optional human reviewer identifier.",
          },
          manualLevel: {
            type: "enum",
            required: true,
            values: ["L1", "L2", "L3", "L4", "L5", "L6"],
            description:
              "Required whole-task manual rating. Gap analysis uses overallComment as the manual basis when present.",
          },
          overallComment: {
            type: "string",
            required: false,
            description:
              "Optional whole-task human comment for issues the current agent missed or did not identify.",
          },
          itemReviews: {
            type: "array",
            required: false,
            description:
              "Optional per-item human review results. Missing or empty arrays are valid.",
            items: {
              type: "object",
              description:
                "One item review with itemId and agree, plus reason when agree is false.",
            },
          },
          riskReviews: {
            type: "array",
            required: false,
            description:
              "Optional per-risk review results using high, medium, low, or none levels. Missing or empty arrays are valid.",
            items: {
              type: "object",
              description:
                "One risk review with riskId, agree, and correctedLevel plus reason when agree is false.",
            },
          },
        },
      },
    },
    responses: [
      {
        status: 200,
        description:
          "Human review item and risk review calibration samples were appended; score fields are recalculated when reviewed entries have score_effect metadata.",
        body: {
          type: "object",
          description: "Human review acceptance response.",
          properties: {
            success: successField,
            taskId: taskIdField,
            status: {
              type: "string",
              required: true,
              description:
                "Submission processing status. Completed for first-version synchronous handling.",
            },
            summary: {
              type: "object",
              required: true,
              description:
                "Synchronous summary with review counts, datasetItemCount, hasOverallComment, gap analysis status, and score recalculation fields when score changes are applied.",
            },
            message: messageField,
          },
        },
      },
      { status: 400, description: "Invalid human review payload.", body: errorResponseBody },
      {
        status: 404,
        description: "Task record or result file was not found.",
        body: errorResponseBody,
      },
      {
        status: 409,
        description: "Task exists but has not completed yet.",
        body: errorResponseBody,
      },
    ],
  },
];

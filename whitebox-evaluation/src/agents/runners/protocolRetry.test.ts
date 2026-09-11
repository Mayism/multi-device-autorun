import assert from "node:assert/strict";
import test from "node:test";
import type { OpencodeRunRequest, OpencodeRunResult } from "../opencode/cliRunner.js";
import type { AgentBootstrapPayload, RubricScoringPayload } from "../../types.js";
import { runOpencodeRubricScoring } from "./opencodeRubricScoring.js";
import { runOpencodeRuleAssessment } from "./opencodeRuleAssessment.js";

function failedRun(rawText: string, index: number): OpencodeRunResult {
  return {
    requestTag: `attempt-${String(index)}`,
    rawText,
    rawEvents: "",
    elapsedMs: 1,
    sessionId: `ses_attempt${String(index)}`,
  };
}

test("rubric retry uses a fresh session with the full contract, errors, payload and prior output", async () => {
  const requests: OpencodeRunRequest[] = [];
  const invalidOutput = JSON.stringify({
    summary: {
      overall_assessment: "旧结构评分",
      overall_confidence: "medium",
      strengths: ["错误层级"],
    },
    item_scores: [
      {
        dimension_name: "质量",
        item_name: "正确性",
        score: 10,
        rationale: "说明",
        evidence_used: [],
      },
    ],
    risks: [],
  });
  const scoringPayload = {
    case_context: {
      case_id: "CaseProtocol",
      case_root: "/case",
      task_type: "continuation",
      original_prompt_summary: "修复页面",
      original_project_path: "/case/original",
      generated_project_path: "/case/base",
    },
    task_understanding: {},
    rubric_summary: {
      task_type: "continuation",
      evaluation_mode: "test",
      scenario: "test",
      scoring_method: "discrete_band",
      scoring_note: "test",
      common_risks: [],
      report_emphasis: [],
      dimension_summaries: [
        {
          name: "质量",
          weight: 10,
          intent: "test",
          item_summaries: [
            {
              name: "正确性",
              weight: 10,
              scoring_bands: [{ score: 10, criteria: "通过" }],
            },
          ],
        },
      ],
      hard_gates: [],
      review_rule_summary: [],
    },
    response_contract: {
      output_language: "zh-CN",
      json_only: true,
    },
  } as unknown as RubricScoringPayload;

  const result = await runOpencodeRubricScoring({
    sandboxRoot: "/sandbox",
    scoringPayload,
    runPrompt: async (request) => {
      requests.push(request);
      return failedRun(invalidOutput, requests.length);
    },
  });

  assert.equal(result.outcome, "protocol_error");
  assert.equal(requests.length, 3);
  assert.match(requests[0]!.prompt, /rubric_output_json_schema:/);
  assert.match(requests[0]!.prompt, /"review_required"/);
  const retryPrompt = requests[1]!.prompt;
  assert.equal(requests[1]!.continueSessionId, undefined);
  assert.match(retryPrompt, /item_scores\.0\.confidence/);
  assert.match(retryPrompt, /item_scores\.0\.review_required/);
  assert.match(retryPrompt, /hard_gate_candidates/);
  assert.match(retryPrompt, /main_issues/);
  assert.match(retryPrompt, /previous_invalid_output:/);
  assert.match(retryPrompt, /旧结构评分/);
  assert.match(retryPrompt, /scoring_payload:/);
});

test("rule retry uses a fresh session with the full contract, errors, payload and prior output", async () => {
  const requests: OpencodeRunRequest[] = [];
  const invalidOutput = JSON.stringify({
    summary: { total: 1, pass: 1 },
    rule_assessments: [
      {
        rule_id: "RULE-1",
        decision: "pass",
        reason: "旧结构判定",
        evidence_used: [],
        needs_human_review: false,
      },
    ],
  });
  const bootstrapPayload = {
    case_context: {
      case_id: "CaseProtocol",
      case_root: "/case",
      task_type: "continuation",
      original_prompt_summary: "修复页面",
      original_project_path: "/case/original",
      generated_project_path: "/case/base",
    },
    task_understanding: {},
    assisted_rule_candidates: [
      {
        rule_id: "RULE-1",
        rule_name: "测试规则",
        why_uncertain: "需要 Agent 判断",
      },
    ],
  } as unknown as AgentBootstrapPayload;

  const result = await runOpencodeRuleAssessment({
    sandboxRoot: "/sandbox",
    bootstrapPayload,
    runPrompt: async (request) => {
      requests.push(request);
      return failedRun(invalidOutput, requests.length);
    },
  });

  assert.equal(result.outcome, "protocol_error");
  assert.equal(requests.length, 3);
  assert.match(requests[0]!.prompt, /rule_assessment_output_json_schema:/);
  assert.match(requests[0]!.prompt, /"assistant_scope"/);
  const retryPrompt = requests[1]!.prompt;
  assert.equal(requests[1]!.continueSessionId, undefined);
  assert.match(retryPrompt, /summary\.assistant_scope/);
  assert.match(retryPrompt, /rule_assessments\.0\.confidence/);
  assert.match(retryPrompt, /previous_invalid_output:/);
  assert.match(retryPrompt, /旧结构判定/);
  assert.match(retryPrompt, /bootstrap_payload:/);
});

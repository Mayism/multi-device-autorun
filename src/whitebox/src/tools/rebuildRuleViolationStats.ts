import { getConfig } from "../config.js";
import { rebuildRuleViolationStatsIndex } from "../datasets/ruleViolation/statsRebuild.js";

async function main(): Promise<void> {
  const config = getConfig();
  const summary = await rebuildRuleViolationStatsIndex(config.localCaseRoot);
  console.info(
    `rule_violation_stats_rebuild_completed localCaseRoot=${config.localCaseRoot} scannedResultFiles=${String(summary.scannedResultFiles)} rebuiltRuns=${String(summary.rebuiltRuns)} skippedFiles=${String(summary.skippedFiles)}`,
  );
}

main().catch((error) => {
  console.error(
    `rule_violation_stats_rebuild_failed error=${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
});

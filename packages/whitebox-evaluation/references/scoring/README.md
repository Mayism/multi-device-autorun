# Scoring References

This directory contains the rubric, schema, and scoring reference notes used by the scoring workflow.

Files in this directory are the repo-local source of truth for:

- `rubric.yaml`
- `report_result_schema.json`
- task-type rubric notes and rule application notes

Static scoring rule packs are maintained as YAML files in `references/rules/`, not in this scoring reference directory.

The runtime default `referenceRoot` resolves to `references/scoring` unless `DEFAULT_REFERENCE_ROOT` is explicitly set.

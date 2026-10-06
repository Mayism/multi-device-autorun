# Scoring References

This directory contains the rubric, schema, and scoring reference notes used by the scoring workflow.

Files in this directory are the repo-local source of truth for:

- `rubric.yaml`
- `report_result_schema.json`
- task-type rubric notes and rule application notes

Static scoring rule packs are maintained as YAML files in `../rules/`.

The Python evaluator loads these files from the bundled `pyautorun.whitebox_eval.resources` package.

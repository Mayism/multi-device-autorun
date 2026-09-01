import assert from "node:assert/strict";
import test from "node:test";
import { parseJson5ish } from "../src/execution/project/json5ish.js";

test("parseJson5ish parses single-quoted keys and values", () => {
  const result = parseJson5ish(`{
    'app': {
      'bundleName': 'com.example.runner',
      'description': 'Runner says "hello"',
      'owner': 'developer\\'s app',
    },
  }`);

  assert.deepEqual(result, {
    app: {
      bundleName: "com.example.runner",
      description: 'Runner says "hello"',
      owner: "developer's app",
    },
  });
});

test("parseJson5ish keeps comment markers in single-quoted strings", () => {
  const result = parseJson5ish(`{
    // An unmatched " in a comment must not affect string parsing.
    'lineComment': 'not // a comment',
    'blockComment': 'not /* a comment */ either',
    'trailingCommaLike': 'keep ,}',
  }`);

  assert.deepEqual(result, {
    lineComment: "not // a comment",
    blockComment: "not /* a comment */ either",
    trailingCommaLike: "keep ,}",
  });
});

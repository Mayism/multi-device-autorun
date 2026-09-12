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

test("parseJson5ish parses unquoted keys as written by DevEco JSON5 templates", () => {
  const result = parseJson5ish(`{
  app: {
    bundleName: 'org.hadss.rnim',
    versionCode: 1000000,
  },
  modules: [
    {
      name: 'entry',
      srcPath: './entry',
    },
  ],
}`);

  assert.deepEqual(result, {
    app: {
      bundleName: "org.hadss.rnim",
      versionCode: 1000000,
    },
    modules: [{ name: "entry", srcPath: "./entry" }],
  });
});

test("parseJson5ish does not quote identifiers in value position", () => {
  const result = parseJson5ish(`{
    "flag": true,
    "empty": null,
    "nested": { "key": "value" },
  }`);

  assert.deepEqual(result, {
    flag: true,
    empty: null,
    nested: { key: "value" },
  });
});

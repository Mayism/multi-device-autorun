import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { CloudTestClient, extractTokenJson } from "./cloudtest-client.mjs";
import { runPythonWorker } from "../runtime/python-worker.mjs";

const token = (access) => JSON.stringify({ accesstoken: access, createtime: 1800000000000, expiretime: 3600 });
const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};
const close = (server) => new Promise((resolve) => server.close(resolve));
const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
};

test("cloud client refreshes cookie and csrf, retries 401, and routes report requests", async () => {
  const seen = [];
  const { server, base } = await listen(async (req, res) => {
    const body = await readBody(req);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: body.toString("utf8") });
    if (req.url === "/refresh") {
      res.setHeader("Set-Cookie", `agc_authInfo=${encodeURIComponent(token("new"))}; Path=/`);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: { csrfToken: "csrf-new" } }));
    } else if (req.headers.cookie !== `agc_authInfo=${encodeURIComponent(token("new"))}`) {
      res.writeHead(401);
      res.end("expired");
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: 200, data: { listResult: [{ id: "app-1" }] } }));
    }
  });
  try {
    const client = new CloudTestClient({
      teamId: "team", projectId: "project", agcAuthInfo: `agc_authInfo=${encodeURIComponent(token("old"))}; csrfToken=csrf-old`,
      baseUrl: `${base}/task`, reportBaseUrl: `${base}/report`, refreshUrl: `${base}/refresh`,
    });
    assert.deepEqual(await client.listApps(), [{ id: "app-1" }]);
    assert.equal(client.csrfToken, "csrf-new");
    assert.equal(JSON.parse(client.tokenJson).accesstoken, "new");
    assert.equal(seen[0].url, "/task/app/list/1/100/1");
    assert.equal(seen[1].method, "GET");
    assert.equal(seen[1].body, JSON.stringify({ agcTeamId: "team" }));
    assert.equal(Number(seen[1].headers["content-length"]), Buffer.byteLength(seen[1].body));
    assert.equal(seen[2].headers.agccsrftoken, "csrf-new");
    assert.equal(seen[2].headers.productid, "project");
    await client.request("GET", "report/overview/result", { root: "report", query: { taskGroupId: "x y", category: [1, 2] } });
    assert.equal(seen[3].url, "/report/report/overview/result?taskGroupId=x+y&category=1&category=2");
  } finally {
    await close(server);
  }
});

test("cloud client calculates digest and uploads signed bytes through HTTP proxy", async () => {
  const received = [];
  const { server: proxy, base: proxyBase } = await listen(async (req, res) => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body: await readBody(req) });
    res.writeHead(200);
    res.end("ok");
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-cloud-client-"));
  const appPath = path.join(dir, "sample.app");
  await fs.writeFile(appPath, Buffer.from([0, 1, 2, 255]));
  try {
    const digest = JSON.parse((await runPythonWorker("cloudtest-client-digest", { appPath })).toString("utf8"));
    assert.equal(digest.fileSize, 4);
    assert.equal(digest.sha256, createHash("sha256").update(Buffer.from([0, 1, 2, 255])).digest("hex"));
    const client = new CloudTestClient({ teamId: "team", projectId: "project", agcAuthInfo: token("old"), proxy: proxyBase.replace("http://", "http://user:pass@") });
    await client.putObject({
      url: "http://obs.example.test/upload?key=1", method: "PUT",
      headers: { Host: "obs.example.test", "Content-Type": "application/octet-stream", "Content-Length": "4", "x-amz-meta-check": "signed", Connection: "close" },
    }, appPath, digest);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, "PUT");
    assert.equal(received[0].url, "http://obs.example.test/upload?key=1");
    assert.equal(received[0].headers["x-amz-meta-check"], "signed");
    assert.equal(received[0].headers.host, "obs.example.test");
    assert.equal(received[0].headers["content-length"], "4");
    assert.deepEqual(received[0].body, Buffer.from([0, 1, 2, 255]));
    assert.equal(received[0].headers["proxy-authorization"], `Basic ${Buffer.from("user:pass").toString("base64")}`);
    await fs.writeFile(appPath, Buffer.from([0, 1, 2, 254]));
    await assert.rejects(client.putObject({ url: "http://obs.example.test/upload", headers: {} }, appPath, digest), /计算摘要后发生变化/);
    assert.equal(received.length, 1);
  } finally {
    await close(proxy);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("extractTokenJson accepts URL encoded cookie and raw JSON", () => {
  assert.equal(extractTokenJson(token("raw")), token("raw"));
  assert.equal(extractTokenJson(`x=1; agc_authInfo=${encodeURIComponent(token("encoded"))}; csrfToken=2`), token("encoded"));
  const quoted = `authInfo="${token("quoted").replaceAll('"', '\\"')}"; csrfToken=2`;
  const client = new CloudTestClient({ teamId: "team", projectId: "project", agcAuthInfo: quoted });
  assert.equal(JSON.parse(client.tokenJson).accesstoken, "quoted");
  assert.equal(client.baseHeaders().agcCsrfToken, "2");
});

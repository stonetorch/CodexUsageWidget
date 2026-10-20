import assert from "node:assert/strict";
import http from "node:http";
import { listCdpTargets } from "../src/cdp-client.mjs";

const originalFetch = globalThis.fetch;
const page = { id: "main", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://[::1]:9237/devtools/page/main" };
const calls = [];
try {
  globalThis.fetch = async (url) => {
    calls.push(url);
    return Response.json([page, { type: "worker", webSocketDebuggerUrl: "ws://[::1]:9237/worker" }, null]);
  };
  assert.deepEqual(await listCdpTargets(9237), [page]);
  assert.deepEqual(calls.splice(0), ["http://127.0.0.1:9237/json/list"]);

  for (const failure of [
    () => { throw new TypeError("fetch failed"); },
    () => new Response("unavailable", { status: 503 }),
    () => Response.json({ invalid: true }),
  ]) {
    globalThis.fetch = async (url) => {
      calls.push(url);
      return url.includes("127.0.0.1") ? failure() : Response.json([page]);
    };
    assert.deepEqual(await listCdpTargets(9237), [page]);
    assert.deepEqual(calls.splice(0), ["http://127.0.0.1:9237/json/list", "http://[::1]:9237/json/list"]);
  }

  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(listCdpTargets(9237), /127\.0\.0\.1:9237.*\[::1\]:9237/);
} finally { globalThis.fetch = originalFetch; }

// Exercise a real IPv6-only listener, matching the updated desktop's binding.
const server = http.createServer((request, response) => {
  assert.equal(request.url, "/json/list");
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify([page]));
});
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "::1", port: 0, ipv6Only: true }, resolve);
  });
  assert.deepEqual(await listCdpTargets(server.address().port), [page]);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log("CDP discovery: ok (IPv4, IPv6 fallback, endpoint failures, IPv6-only listener)");

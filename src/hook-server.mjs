import http from "node:http";
import { parseTranscriptFile } from "./transcript.mjs";

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("Hook payload is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function parseWithRetry(filePath, turnId) {
  let lastResult = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt) await wait(250 * attempt);
    try {
      const result = parseTranscriptFile(filePath, turnId);
      if (result) return result;
      lastResult = result;
    } catch {
      // The transcript may still be flushing. Retry briefly.
    }
  }
  return lastResult;
}

export function startHookServer({ port, store, logger = console }) {
  const diagnostics = { savedTurns: 0, lastError: null };
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ running: true, ...diagnostics, persistence: store.persistenceStatus?.() || null }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/hook") {
      response.writeHead(404).end();
      return;
    }
    try {
      const event = await readJson(request);
      if (event.hook_event_name !== "Stop" || !event.transcript_path || !event.session_id || !event.turn_id) {
        response.writeHead(400, { "content-type": "application/json" }).end('{"saved":false,"error":"invalid-event"}');
        return;
      }
      const metrics = await parseWithRetry(event.transcript_path, event.turn_id);
      if (!metrics) {
        diagnostics.lastError = "transcript-unavailable";
        response.writeHead(422, { "content-type": "application/json" }).end('{"saved":false,"error":"transcript-unavailable"}');
        return;
      }
      store.recordTurn(event, metrics);
      diagnostics.savedTurns += 1;
      diagnostics.lastError = null;
      response.writeHead(200, { "content-type": "application/json" }).end('{"saved":true}');
    } catch (error) {
      diagnostics.lastError = error?.code || error?.name || "hook-error";
      logger.warn?.(`Hook event failed: ${error.message}`);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" }).end('{"saved":false,"error":"hook-error"}');
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

import http from "node:http";
import fs from "node:fs";
import { connectionPath } from "./config.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  try {
    const raw = await readStdin();
    const event = JSON.parse(raw || "{}");
    const connection = JSON.parse(fs.readFileSync(connectionPath(), "utf8"));
    const body = Buffer.from(JSON.stringify(event));
    await new Promise((resolve) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: connection.hookPort,
          path: "/hook",
          method: "POST",
          timeout: 1500,
          headers: { "content-type": "application/json", "content-length": body.length },
        },
        (response) => {
          if (response.statusCode !== 200) {
            process.stderr.write(`Codex Usage Widget: Stop hook was not saved (HTTP ${response.statusCode}).\n`);
          }
          response.resume();
          response.on("end", resolve);
        },
      );
      request.on("timeout", () => request.destroy());
      request.on("error", resolve);
      request.end(body);
    });
  } catch {
    // Hooks must never interfere with Codex if the overlay is not running.
  }
  process.stdout.write("{}\n");
}

await main();

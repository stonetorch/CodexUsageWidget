import http from "node:http";
import { injectionSource } from "../src/dom-overlay.mjs";

const state = {
  limits: {
    primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1788947564 },
    secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1789460832 },
  },
  sessions: {
    demo: {
      sessionId: "demo",
      updatedAt: new Date().toISOString(),
      conversationUsage: { total_tokens: 2494465 },
      turns: [{
        turnId: "demo-turn",
        lastAssistantMessage: "我已经完成修改，并验证了测试全部通过。",
        usage: { input_tokens: 127112, cached_input_tokens: 124544, output_tokens: 829, total_tokens: 127941 },
        rateLimitDelta: { primary: 1, secondary: 0 },
      }],
    },
  },
};

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html{color-scheme:dark}body{margin:0;background:#171717;color:#eee;font:14px system-ui}.shell{max-width:820px;margin:auto;padding:80px 20px 150px}.message{max-width:680px;margin:30px 0 30px auto;padding:18px;border-radius:18px;background:#222}.composer{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);width:min(760px,calc(100vw - 40px));padding:12px 14px 42px;border:1px solid #444;border-radius:20px;background:#242424}.composer textarea{width:100%;height:42px;box-sizing:border-box;background:transparent;color:white;border:0;resize:none;outline:0}.controls,.right-controls{position:absolute;bottom:9px;display:flex;gap:8px;align-items:center}.controls{left:14px}.right-controls{right:10px}.composer button{height:28px;border:0;border-radius:14px;padding:0 10px;background:#333;color:#ddd}.composer .send{width:32px;padding:0;background:#1677ff}
</style></head><body><main class="shell"><div class="message"><p>我已经完成修改，并验证了测试全部通过。</p></div></main><div class="composer"><textarea aria-label="输入消息" placeholder="给 Codex 发送消息"></textarea><div class="controls"><button>＋</button><button>帮我批准</button></div><div class="right-controls"><button>Git</button><button>本地</button><button class="send" aria-label="发送">↑</button></div></div><script>${injectionSource(state)}</script></body></html>`;
const server = http.createServer((_request, response) => response.end(html));
server.listen(41737, "127.0.0.1", () => console.log("http://127.0.0.1:41737"));

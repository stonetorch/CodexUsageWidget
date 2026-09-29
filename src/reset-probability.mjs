// 第三方公开预测：Tibo 随机重置 Codex 额度的概率。
// 只有 Node 进程访问该接口：浮窗注入在 Codex 渲染进程里，跨域请求会被拦掉，
// 而且注入代码保持“只渲染快照、不连网”。
export const RESET_PROBABILITY_ENDPOINT = "https://codex.gussuriworks.com/api/current?locale=zh";
export const RESET_PROBABILITY_TIMEOUT_MS = 10_000;
export const RESET_PROBABILITY_REFRESH_MS = 10 * 60 * 1000;

const HORIZONS = Object.freeze(["12h", "24h", "48h", "72h"]);

function probability(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

function timestamp(value) {
  const text = String(value || "");
  return Number.isFinite(Date.parse(text)) ? text : null;
}

// 外部边界的校验：结构不符就返回 null，由调用方保留上一次的可用数据。
export function normalizeResetProbabilities(payload) {
  const viewModel = payload?.viewModel;
  if (!viewModel || typeof viewModel !== "object") return null;
  const horizons = Object.fromEntries(HORIZONS.map((horizon) => [`p${horizon}`, probability(viewModel[`probability${horizon}`])]));
  if (HORIZONS.every((horizon) => horizons[`p${horizon}`] === null)) return null;
  return { checkedAt: timestamp(payload.checkedAt) || timestamp(viewModel.lastUpdated), ...horizons };
}

export async function fetchResetProbabilities(options = {}) {
  const {
    endpoint = RESET_PROBABILITY_ENDPOINT,
    timeoutMs = RESET_PROBABILITY_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;
  const response = await fetchImpl(endpoint, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return normalizeResetProbabilities(await response.json());
}

import fs from "node:fs";
import path from "node:path";
import { statePath } from "./config.mjs";

export const DEFAULT_SETTINGS = Object.freeze({
  sidebar: false,
  turnBadges: false,
  budgets: { primary: 1, secondary: 5 },
});
const EMPTY_STATE = { version: 2, updatedAt: null, limits: null, sessions: {}, settings: DEFAULT_SETTINGS };

export class StateStore extends EventTarget {
  constructor(filePath = statePath()) {
    super();
    this.filePath = filePath;
    this.state = this.#read();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  setLimits(limits) {
    this.state.limits = limits;
    this.#commit();
  }

  updateSettings(input) {
    if (!input || typeof input !== "object") return;
    const settings = this.state.settings || DEFAULT_SETTINGS;
    const budgets = input.budgets || {};
    const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 0.01 && Number(value) <= 1000
      ? Number(value) : fallback;
    this.state.settings = {
      sidebar: input.sidebar === true,
      turnBadges: input.turnBadges === true,
      budgets: {
        primary: positive(budgets.primary, settings.budgets?.primary ?? DEFAULT_SETTINGS.budgets.primary),
        secondary: positive(budgets.secondary, settings.budgets?.secondary ?? DEFAULT_SETTINGS.budgets.secondary),
      },
    };
    this.#commit();
  }

  recordTurn(event, metrics) {
    const sessionId = event.session_id || event.sessionId;
    const turnId = event.turn_id || event.turnId;
    if (!sessionId || !turnId || !metrics) return;
    const session = this.state.sessions[sessionId] || {
      sessionId,
      cwd: event.cwd || null,
      model: event.model || metrics.model || null,
      conversationUsage: null,
      turns: [],
      updatedAt: null,
    };
    session.cwd = event.cwd || session.cwd;
    session.model = event.model || metrics.model || session.model;
    session.conversationUsage = metrics.conversationUsage;
    session.updatedAt = new Date().toISOString();
    const record = {
      turnId,
      completedAt: new Date().toISOString(),
      model: metrics.model || event.model || null,
      usage: metrics.turnUsage,
      rateLimitDelta: metrics.rateLimitDelta,
      lastAssistantMessage: event.last_assistant_message || metrics.lastAssistantMessage || null,
    };
    session.turns = [...session.turns.filter((turn) => turn.turnId !== turnId), record].slice(-200);
    this.state.sessions[sessionId] = session;

    const newest = Object.values(this.state.sessions)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, 100);
    this.state.sessions = Object.fromEntries(newest.map((entry) => [entry.sessionId, entry]));
    this.#commit();
  }

  #read() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        ...structuredClone(EMPTY_STATE),
        ...saved,
        settings: {
          ...structuredClone(DEFAULT_SETTINGS),
          ...saved.settings,
          budgets: { ...DEFAULT_SETTINGS.budgets, ...saved.settings?.budgets },
        },
      };
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  #commit() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.state.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    this.dispatchEvent(new Event("changed"));
  }
}

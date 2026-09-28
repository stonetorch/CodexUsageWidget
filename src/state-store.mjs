import fs from "node:fs";
import { ensureAppDataDirectory, statePath } from "./config.mjs";

const EMPTY_STATE = { version: 1, updatedAt: null, limits: null, sessions: {} };

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
      return { ...structuredClone(EMPTY_STATE), ...JSON.parse(fs.readFileSync(this.filePath, "utf8")) };
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  #commit() {
    ensureAppDataDirectory();
    this.state.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    this.dispatchEvent(new Event("changed"));
  }
}

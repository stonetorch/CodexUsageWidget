import fs from "node:fs";
import path from "node:path";
import { statePath } from "./config.mjs";

export const DEFAULT_SETTINGS = Object.freeze({
  sidebar: false,
  turnBadges: false,
  budgets: { primary: 1, secondary: 5 },
  calibrationResetAt: null,
});
const EMPTY_STATE = { version: 5, updatedAt: null, limits: null, sessions: {}, settings: DEFAULT_SETTINGS };

export class StateStore extends EventTarget {
  constructor(filePath = statePath()) {
    super();
    this.filePath = filePath;
    this.state = this.#read();
    this.activeTurns = new Map();
  }

  snapshot() {
    return { ...structuredClone(this.state), activeTurns: Object.fromEntries(this.activeTurns) };
  }

  setActiveTurn(sessionId, turn) {
    const previous = this.activeTurns.get(sessionId);
    if (JSON.stringify(previous) === JSON.stringify(turn)) return;
    if (turn) this.activeTurns.set(sessionId, turn);
    else this.activeTurns.delete(sessionId);
    this.dispatchEvent(new Event("changed"));
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
      calibrationResetAt: settings.calibrationResetAt || null,
      budgets: {
        primary: positive(budgets.primary, settings.budgets?.primary ?? DEFAULT_SETTINGS.budgets.primary),
        secondary: positive(budgets.secondary, settings.budgets?.secondary ?? DEFAULT_SETTINGS.budgets.secondary),
      },
    };
    this.#commit();
  }

  clearCalibrationEvidence(at = new Date().toISOString()) {
    const parsed = Date.parse(at);
    if (!Number.isFinite(parsed)) return;
    this.state.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...this.state.settings,
      calibrationResetAt: new Date(parsed).toISOString(),
    };
    this.#commit();
  }

  recordTurn(event, metrics) {
    const sessionId = event.session_id || event.sessionId;
    const turnId = event.turn_id || event.turnId;
    if (!sessionId || !turnId || !metrics) return;
    if (this.activeTurns.get(sessionId)?.turnId === turnId) this.activeTurns.delete(sessionId);
    const session = this.state.sessions[sessionId] || {
      sessionId,
      cwd: event.cwd || null,
      model: event.model || metrics.model || null,
      conversationUsage: null,
      turns: [],
      updatedAt: null,
    };
    session.cwd = event.cwd || session.cwd;
    const metricsAt = metrics.completedAt || null;
    const accountingVersion = metrics.accountingVersion || 1;
    const previousVersion = session.usageAccountingVersion || 1;
    // Legacy completion times may be the recovery time, not the source time.
    // A verified ledger replaces legacy totals even when its real timestamp is older.
    if (accountingVersion > previousVersion || (accountingVersion === previousVersion
      && (!session.usageUpdatedAt || (metricsAt && Date.parse(metricsAt) >= Date.parse(session.usageUpdatedAt))))) {
      session.model = metrics.model || event.model || session.model;
      session.conversationUsage = metrics.conversationUsage;
      session.usageUpdatedAt = metricsAt;
      session.usageAccountingVersion = accountingVersion;
    }
    session.updatedAt = new Date().toISOString();
    const record = {
      turnId,
      startedAt: metrics.startedAt || null,
      completedAt: metricsAt,
      accountingVersion,
      usageSource: metrics.usageSource || "unknown",
      model: metrics.model || event.model || null,
      usage: metrics.turnUsage,
      rateLimitDelta: metrics.rateLimitDelta,
      quotaObservations: metrics.quotaObservations || [],
      lastAssistantMessage: event.last_assistant_message || metrics.lastAssistantMessage || null,
    };
    session.turns = [...session.turns.filter((turn) => turn.turnId !== turnId), record]
      .sort((a, b) => String(a.completedAt || "").localeCompare(String(b.completedAt || ""))).slice(-200);
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
        version: EMPTY_STATE.version,
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

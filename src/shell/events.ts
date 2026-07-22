import { EventEmitter } from "node:events";

export type AgentState =
  | "idle"
  | "paused"
  | "thinking"
  | "analyzing"
  | "preparing"
  | "signing"
  | "posting"
  | "error";

export type ShellEvent = {
  id: string;
  ts: number;
  type: string;
  message: string;
  data?: unknown;
};

const bus = new EventEmitter();
bus.setMaxListeners(50);

const MAX_LOG = 200;
const log: ShellEvent[] = [];
let seq = 0;

let agentState: AgentState = "idle";
let running = false;
let lastThesis = "";
let lastError: string | null = null;

export function getAgentState(): AgentState {
  return agentState;
}

export function isRunning(): boolean {
  return running;
}

export function setRunning(value: boolean, message?: string) {
  running = value;
  emitEvent(
    "agent.running",
    message ?? (value ? "Autopilot running" : "Autopilot paused"),
    {
      running: value,
    },
  );
}

export function setAgentState(state: AgentState, message?: string) {
  agentState = state;
  emitEvent("agent.state", message ?? `State → ${state}`, { state });
}

export function setLastThesis(thesis: string) {
  lastThesis = thesis;
}

export function getLastThesis(): string {
  return lastThesis;
}

export function getLastError(): string | null {
  return lastError;
}

export function emitEvent(type: string, message: string, data?: unknown): ShellEvent {
  const ev: ShellEvent = {
    id: `${Date.now()}-${++seq}`,
    ts: Date.now(),
    type,
    message,
    data,
  };
  if (type === "agent.error") {
    lastError = message;
  }
  log.push(ev);
  if (log.length > MAX_LOG) log.shift();
  bus.emit("event", ev);
  return ev;
}

export function getRecentEvents(limit = 100): ShellEvent[] {
  return log.slice(-limit);
}

export function subscribe(handler: (ev: ShellEvent) => void): () => void {
  bus.on("event", handler);
  return () => bus.off("event", handler);
}

export function snapshotRuntime() {
  return {
    state: agentState,
    running,
    lastThesis,
    lastError,
    events: getRecentEvents(50),
  };
}

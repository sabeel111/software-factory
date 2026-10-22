// Live connection: snapshot from /api/state, then events over SSE, folded with the shared reducer.
import { useEffect, useState } from "preact/hooks";
import { initialState, reduce, type LiveState } from "../events/state.js";
import type { FactoryEvent, JobKind } from "../events/types.js";

declare global {
  interface Window {
    __FACTORY__?: { token: string; mode: "demo" | "live" };
  }
}

export const boot = window.__FACTORY__ ?? { token: "", mode: "live" as const };

export type Connection = "connecting" | "live" | "offline";
export interface Running {
  kind: JobKind;
  batchId: string;
  label: string;
}

interface Snapshot {
  state: LiveState;
  running: Running | null;
  connection: Connection;
  /** Bumped on every applied event, for consumers that refetch (history, bench). */
  version: number;
}

type Listener = () => void;

class LiveStore {
  snap: Snapshot = { state: initialState(), running: null, connection: "connecting", version: 0 };
  private listeners = new Set<Listener>();
  private source?: EventSource;
  private pending: FactoryEvent[] = [];
  private frame = 0;

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.notify();
  }

  async start() {
    try {
      const r = await fetch("/api/state");
      const data = (await r.json()) as { state: LiveState; running: Running | null };
      this.set({ state: data.state, running: data.running });
    } catch {
      this.set({ connection: "offline" });
    }
    this.connect();
  }

  private connect() {
    this.source?.close();
    const es = new EventSource(`/api/events?after=${this.snap.state.lastSeq}`);
    this.source = es;
    es.onopen = () => this.set({ connection: "live" });
    es.onerror = () =>
      this.set({ connection: es.readyState === EventSource.CLOSED ? "offline" : "connecting" });
    es.addEventListener("reset", () => {
      // The server's buffer no longer reaches our last event: resync from a fresh snapshot.
      void this.start();
    });
    es.addEventListener("factory", (m) => {
      this.pending.push(JSON.parse((m as MessageEvent).data) as FactoryEvent);
      // Batch bursts of events into one render per frame.
      if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
    });
  }

  private flush() {
    this.frame = 0;
    let { state, running } = this.snap;
    for (const e of this.pending) {
      state = reduce(state, e);
      if (e.type === "job.started") running = { kind: e.job, batchId: e.batchId, label: e.label };
      if (e.type === "job.finished") running = null;
    }
    this.pending = [];
    this.set({ state, running, version: this.snap.version + 1 });
  }
}

export const store = new LiveStore();

export function useLive(): Snapshot {
  const [snap, setSnap] = useState(store.snap);
  useEffect(() => store.subscribe(() => setSnap(store.snap)), []);
  return snap;
}

/** A clock that ticks once a second, for live elapsed timers. */
export function useNow(active = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: {
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(init?.method && init.method !== "GET" ? { "X-Factory-Token": boot.token } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data;
}

/** GET a JSON resource, refetching whenever `dep` changes. */
export function useResource<T>(
  path: string | null,
  dep: unknown = 0,
): { data?: T; error?: string; loading: boolean } {
  const [s, setS] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path)
      .then((data) => live && setS({ data, loading: false }))
      .catch((e: Error) => live && setS({ error: e.message, loading: false }));
    return () => {
      live = false;
    };
  }, [path, dep]);
  return s;
}

// Toasts
type Toast = { id: number; text: string };
let toastId = 0;
let toasts: Toast[] = [];
const toastListeners = new Set<() => void>();
export function toast(text: string) {
  const t = { id: ++toastId, text };
  toasts = [...toasts, t];
  toastListeners.forEach((l) => l());
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastListeners.forEach((l) => l());
  }, 4500);
}
export function useToasts(): Toast[] {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    toastListeners.add(l);
    return () => void toastListeners.delete(l);
  }, []);
  return toasts;
}

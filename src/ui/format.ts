import type { Stage } from "../events/types.js";

export const STAGE_LABEL: Record<Stage, string> = {
  triage: "Triage",
  worker: "Build",
  verifier: "Verify",
  reviewer: "Review",
  integrator: "Integrate",
  retro: "Retro",
};

export const stageVar = (s: Stage | "integration" | string) =>
  `var(--stage-${s === "integration" ? "integrator" : s})`;

export function money(usd: number, digits = 2): string {
  if (!Number.isFinite(usd)) return "—";
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 3 : digits)}`;
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  // Clamp small negatives: the UI clock ticks once a second, events can be newer than the last tick.
  ms = Math.max(0, ms);
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function when(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`
    : d.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
}

export function pct(x: number | null | undefined, digits = 0): string {
  return x === null || x === undefined ? "—" : `${(x * 100).toFixed(digits)}%`;
}

export const OUTCOME_LABEL: Record<string, string> = {
  pr_opened: "PR opened",
  ready_to_integrate: "Awaiting integration",
  integrated: "Integrated",
  ejected: "Ejected",
  rejected: "Needs info",
  failed: "Failed",
  budget_exceeded: "Over budget",
  cancelled: "Cancelled",
};

export function outcomeTone(outcome?: string): "good" | "bad" | "warn" | "run" | undefined {
  if (!outcome) return undefined;
  if (outcome === "pr_opened" || outcome === "integrated") return "good";
  if (outcome === "rejected" || outcome === "ready_to_integrate") return "warn";
  return "bad";
}

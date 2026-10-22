import { useEffect, useState } from "preact/hooks";
import type { EnvInfo } from "../server/controller.js";
import { money } from "./format.js";
import { IconAlert, IconInfo, IconPlay } from "./icons.js";
import { api, toast, useResource } from "./store.js";

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function StartDialog(props: { env?: EnvInfo; onClose: () => void; onStarted: () => void }) {
  useEscape(props.onClose);
  const ready = useResource<{ number: number; title: string; labels: string[] }[]>("/api/ready");
  const [picked, setPicked] = useState<Set<number> | null>(null);
  const limits = props.env?.limits ?? {};
  const [concurrency, setConcurrency] = useState(String(limits.concurrency ?? 4));
  const [budget, setBudget] = useState(String(limits.maxCostUsdPerRun ?? 25));
  const [busy, setBusy] = useState(false);

  const issues = ready.data ?? [];
  const selected = picked ?? new Set(issues.map((i) => i.number));
  const perIssue = Number(limits.maxCostUsdPerIssue ?? 3);
  const ceiling = Math.min(Number(budget) || 0, selected.size * perIssue);
  const live = props.env?.mode === "live";

  const toggle = (n: number) => {
    const next = new Set(selected);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    setPicked(next);
  };

  const start = async () => {
    setBusy(true);
    try {
      await api("/api/batch", {
        method: "POST",
        body: {
          issues: selected.size === issues.length ? undefined : [...selected],
          concurrency: Number(concurrency),
          maxCostUsdPerRun: Number(budget),
        },
      });
      props.onStarted();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <div class="scrim" onClick={props.onClose} />
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="start-title">
        <div class="dialog-head">
          <h2 id="start-title">Start a batch</h2>
          <div class="muted" style={{ fontSize: 13, marginTop: 4 }}>
            {props.env?.repo} ·{" "}
            {props.env?.prMode === "integrated" ? "one integrated draft PR" : "one draft PR per issue"} ·
            humans merge
          </div>
        </div>
        <div class="dialog-body">
          <div class="field">
            <label>
              Issues labeled <code>factory:ready</code> ({selected.size} of {issues.length} selected)
            </label>
            {ready.loading && <div class="muted">Loading ready issues…</div>}
            {ready.error && (
              <div class="note note-warn">
                <IconAlert /> {ready.error}
              </div>
            )}
            {!ready.loading && !ready.error && issues.length === 0 && (
              <div class="note">No issues are labeled factory:ready.</div>
            )}
            {issues.length > 0 && (
              <div class="issue-pick">
                {issues.map((i) => (
                  <label key={i.number}>
                    <input
                      type="checkbox"
                      checked={selected.has(i.number)}
                      onChange={() => toggle(i.number)}
                    />
                    <span>
                      <b>#{i.number}</b> {i.title}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div class="grid2">
            <div class="field">
              <label for="conc">Concurrency</label>
              <input
                id="conc"
                class="input"
                type="number"
                min={1}
                max={16}
                value={concurrency}
                onInput={(e) => setConcurrency((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <label for="budget">Batch budget (USD)</label>
              <input
                id="budget"
                class="input"
                type="number"
                min={1}
                step={1}
                value={budget}
                onInput={(e) => setBudget((e.target as HTMLInputElement).value)}
              />
            </div>
          </div>
          <div class={`note ${live ? "note-warn" : ""}`}>
            {live ? <IconAlert /> : <IconInfo />}
            <span>
              {props.env?.costNote}{" "}
              {live && (
                <>
                  This batch can spend at most <b>{money(ceiling)}</b>.
                </>
              )}
            </span>
          </div>
        </div>
        <div class="dialog-foot">
          <button class="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button class="btn btn-primary" disabled={busy || selected.size === 0} onClick={start}>
            <IconPlay /> {live ? `Start (up to ${money(ceiling)})` : "Start demo batch"}
          </button>
        </div>
      </div>
    </>
  );
}

export function ConfirmDialog(props: {
  title: string;
  body: preact.ComponentChildren;
  confirm: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  useEscape(props.onClose);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div class="scrim" onClick={props.onClose} />
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="dialog-head">
          <h2 id="confirm-title">{props.title}</h2>
        </div>
        <div class="dialog-body ink2">{props.body}</div>
        <div class="dialog-foot">
          <button class="btn" onClick={props.onClose}>
            Back
          </button>
          <button
            class={`btn ${props.danger ? "btn-danger" : "btn-primary"}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await props.onConfirm();
                props.onClose();
              } catch (e) {
                toast((e as Error).message);
                setBusy(false);
              }
            }}
          >
            {props.confirm}
          </button>
        </div>
      </div>
    </>
  );
}

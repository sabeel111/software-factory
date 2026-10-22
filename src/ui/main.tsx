import "./styles.css";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { EnvInfo } from "../server/controller.js";
import { ConfirmDialog, StartDialog } from "./dialogs.js";
import { IssueDrawer } from "./drawer.js";
import { IconBeaker, IconMoon, IconPlay, IconSun } from "./icons.js";
import { Logo } from "./icons.js";
import { Feed, Floor, JobBar, Lanes, Metrics } from "./live.js";
import { BatchReplayPage, BenchPage, HistoryPage, ImprovePage, SettingsPage } from "./pages.js";
import { api, boot, store, toast, useLive, useNow, useResource, useToasts } from "./store.js";

function useRoute(): string[] {
  const parse = () => (location.hash.replace(/^#\/?/, "") || "live").split("/");
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

function ThemeToggle() {
  const current = () =>
    document.documentElement.dataset.theme ??
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const [theme, setTheme] = useState(current);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("factory.theme", next);
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
    setTheme(next);
  };
  return (
    <button
      class="btn btn-ghost icon-btn"
      onClick={flip}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      {theme === "dark" ? <IconSun /> : <IconMoon />}
    </button>
  );
}

const NAV: [string, string][] = [
  ["live", "Live"],
  ["history", "History"],
  ["bench", "Benchmark"],
  ["improve", "Improvement"],
  ["settings", "Settings"],
];

function EmptyFloor(props: { env?: EnvInfo; onStart: () => void; busy: boolean }) {
  const runReference = async () => {
    try {
      await api("/api/bench", { method: "POST", body: { kind: "reference", split: "all" } });
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <section class="panel hero">
      <div>
        <h1>The floor is quiet.</h1>
        <p>
          Start a batch and watch every issue move through the factory: triage, an isolated build, independent
          verification, review, and integration into a single draft PR that a human merges.
          {props.env?.mode === "demo" &&
            " In demo mode the agents are scripted and nothing costs money; the repo, sandboxes, tests and merges are real."}
        </p>
        <div class="pipeline-diagram" aria-hidden="true">
          {["triage", "worker", "verifier", "reviewer", "integrator"].map((s, k) => (
            <>
              {k > 0 && <span class="arrow">→</span>}
              <span class="node">
                <span class="stage-dot" style={{ background: `var(--stage-${s})` }} />
                {
                  {
                    triage: "Triage",
                    worker: "Build",
                    verifier: "Verify",
                    reviewer: "Review",
                    integrator: "Integrate",
                  }[s]
                }
              </span>
            </>
          ))}
          <span class="arrow">→</span>
          <span class="node">Draft PR</span>
        </div>
      </div>
      <div class="hero-actions">
        <button class="btn" onClick={runReference} disabled={props.busy}>
          <IconBeaker /> Check benchmark
        </button>
        <button class="btn btn-primary" onClick={props.onStart} disabled={props.busy}>
          <IconPlay /> Start a batch
        </button>
      </div>
    </section>
  );
}

function App() {
  const live = useLive();
  const route = useRoute();
  const toasts = useToasts();
  const env = useResource<EnvInfo>("/api/env").data;
  const [starting, setStarting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const running = live.running;
  const now = useNow(Boolean(running));
  const { state } = live;
  const batch = state.batch;
  const page = route[0] ?? "live";
  // Refetch history/bench/improve lists when a job finishes.
  const finishedVersion = state.job?.finishedAt ? state.lastSeq : 0;

  useEffect(() => {
    document.title = running ? `● ${running.label} · Software Factory` : "Software Factory";
  }, [running?.label]);

  const post = async (path: string) => {
    try {
      await api(path, { method: "POST" });
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="#/live" style={{ color: "var(--ink)", textDecoration: "none" }}>
          <span class="brand-mark">
            <Logo />
          </span>
          <span>Software Factory</span>
        </a>
        {boot.mode === "demo" && (
          <span class="badge-demo" title="Scripted agents, zero cost">
            Demo
          </span>
        )}
        <nav class="nav" aria-label="Sections">
          {NAV.map(([id, label]) => (
            <a href={`#/${id}`} aria-current={page === id ? "page" : undefined} key={id}>
              {label}
            </a>
          ))}
        </nav>
        <div class="topbar-right">
          <span class="conn" data-state={live.connection} title={`Event stream: ${live.connection}`}>
            <span class="conn-dot" />
            {live.connection === "live"
              ? "Live"
              : live.connection === "connecting"
                ? "Connecting"
                : "Offline"}
          </span>
          <ThemeToggle />
        </div>
      </header>

      <main class="page">
        {page === "live" && (
          <>
            <JobBar
              state={state}
              running={running}
              now={now}
              onDrain={() => post("/api/batch/drain")}
              onCancel={() => setConfirmCancel(true)}
              onStart={() => setStarting(true)}
            />
            {!batch && (!state.job || !running) && (
              <EmptyFloor env={env} onStart={() => setStarting(true)} busy={Boolean(running)} />
            )}
            {batch && (
              <>
                <Metrics batch={batch} now={batch.finishedAt ? Date.parse(batch.finishedAt) : now} />
                <Floor batch={batch} now={now} onOpen={setOpen} />
                <div class="split">
                  <Lanes batch={batch} now={now} onOpen={setOpen} />
                  <Feed state={state} onOpen={setOpen} />
                </div>
              </>
            )}
            {!batch && state.job && <Feed state={state} onOpen={setOpen} />}
          </>
        )}
        {page === "history" && !route[1] && <HistoryPage version={finishedVersion} />}
        {page === "history" && route[1] && <BatchReplayPage batchId={route[1]} />}
        {page === "bench" && <BenchPage env={env} busy={Boolean(running)} version={finishedVersion} />}
        {page === "improve" && <ImprovePage env={env} busy={Boolean(running)} version={finishedVersion} />}
        {page === "settings" && <SettingsPage env={env} />}
      </main>

      {open !== null && batch?.issues[open] && (
        <IssueDrawer
          issue={batch.issues[open]!}
          now={now}
          canCancel={Boolean(running && running.kind === "batch")}
          onCancel={(n) => post(`/api/issues/${n}/cancel`)}
          onClose={() => setOpen(null)}
        />
      )}
      {starting && (
        <StartDialog
          env={env}
          onClose={() => setStarting(false)}
          onStarted={() => {
            setStarting(false);
            location.hash = "#/live";
          }}
        />
      )}
      {confirmCancel && (
        <ConfirmDialog
          title="Cancel the running job?"
          danger
          confirm="Cancel everything"
          body="In-flight agents are stopped, every claim is released (issues stay ready for the next batch) and every sandbox is cleaned up. To let in-flight work finish instead, use Drain."
          onConfirm={() => api("/api/batch/cancel", { method: "POST" })}
          onClose={() => setConfirmCancel(false)}
        />
      )}
      <div class="toast-wrap" aria-live="assertive">
        {toasts.map((t) => (
          <div class="toast" key={t.id}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

void store.start();
render(<App />, document.getElementById("app")!);

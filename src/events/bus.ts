// EventBus: stamps, buffers, persists and fans out factory events (specs/09-control-ui.md R8.1–R8.3).
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { initialState, reduce, type LiveState } from "./state.js";
import type { EventBody, EventSink, FactoryEvent } from "./types.js";

export type Listener = (e: FactoryEvent) => void;

export class EventBus {
  private seq = 0;
  private readonly buffer: FactoryEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private writes: Promise<void> = Promise.resolve();
  private live: LiveState = initialState();

  constructor(
    /** Run store root; events are appended to <root>/<batchId>/events.jsonl. Null disables persistence. */
    private readonly runsRoot: string | null = "runs",
    private readonly bufferSize = 20_000,
  ) {}

  get state(): LiveState {
    return this.live;
  }

  get lastSeq(): number {
    return this.seq;
  }

  emit(batchId: string, body: EventBody): FactoryEvent {
    const e = { ...body, seq: ++this.seq, at: new Date().toISOString(), batchId } as FactoryEvent;
    this.buffer.push(e);
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    this.live = reduce(this.live, e);
    if (this.runsRoot) {
      const file = join(this.runsRoot, batchId, "events.jsonl");
      // Serialized so the file stays in seq order.
      this.writes = this.writes
        .then(async () => {
          await mkdir(join(this.runsRoot!, batchId), { recursive: true });
          await appendFile(file, JSON.stringify(e) + "\n");
        })
        .catch(() => undefined);
    }
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // a broken listener must never affect the factory
      }
    }
    return e;
  }

  /** A sink bound to one batch, handed to the pipeline. */
  sink(batchId: string): EventSink {
    return (body) => void this.emit(batchId, body);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Buffered events after `seq`, or null if the buffer no longer reaches back that far. */
  since(seq: number): FactoryEvent[] | null {
    if (seq >= this.seq) return [];
    const first = this.buffer[0];
    if (seq > 0 && first && first.seq > seq + 1) return null;
    if (seq === 0 && first && first.seq > 1) return null;
    return this.buffer.filter((e) => e.seq > seq);
  }

  /** Wait for pending writes (tests, shutdown). */
  flush(): Promise<void> {
    return this.writes;
  }
}

export async function readEvents(runsRoot: string, batchId: string): Promise<FactoryEvent[]> {
  const file = join(runsRoot, batchId, "events.jsonl");
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FactoryEvent);
}

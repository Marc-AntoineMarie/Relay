import { describe, expect, it } from "vitest";
import { Monitor } from "../src/monitor/index.js";
import type { Pipeline, PipelineEvent } from "../src/types.js";

const pipeline: Pipeline = {
  id: "p1",
  prompt: "x",
  context: { cwd: "/repo" },
  tasks: [],
  status: "pending",
  created: new Date(),
};

const startEvent: PipelineEvent = { type: "pipeline:start", pipeline };
const chunkEvent: PipelineEvent = { type: "task:chunk", taskId: "1", text: "hello" };

describe("Monitor", () => {
  it("onAny reçoit tous les événements", () => {
    const m = new Monitor();
    const seen: string[] = [];
    m.onAny((e) => seen.push(e.type));
    m.emit(startEvent);
    m.emit(chunkEvent);
    expect(seen).toEqual(["pipeline:start", "task:chunk"]);
  });

  it("on(type) ne reçoit que le type demandé, et expose le payload typé", () => {
    const m = new Monitor();
    const texts: string[] = [];
    m.on("task:chunk", (e) => texts.push(e.text));
    m.emit(startEvent);
    m.emit(chunkEvent);
    expect(texts).toEqual(["hello"]);
  });

  it("le désabonnement arrête la réception", () => {
    const m = new Monitor();
    let count = 0;
    const off = m.onAny(() => count++);
    m.emit(startEvent);
    off();
    m.emit(startEvent);
    expect(count).toBe(1);
  });

  it("pipe rediffuse et ré-expose le flux", async () => {
    const m = new Monitor();
    const relayed: string[] = [];
    m.onAny((e) => relayed.push(e.type));

    async function* source(): AsyncGenerator<PipelineEvent> {
      yield startEvent;
      yield chunkEvent;
    }

    const yielded: string[] = [];
    for await (const e of m.pipe(source())) yielded.push(e.type);

    expect(relayed).toEqual(["pipeline:start", "task:chunk"]);
    expect(yielded).toEqual(["pipeline:start", "task:chunk"]);
  });
});

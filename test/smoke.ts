// Drives the real App + DemoClient on a headless terminal and asserts on the
// rendered screen buffer. Run: npm run smoke
import xtermHeadless from "@xterm/headless";
import { setTimeout as delay } from "node:timers/promises";
import type { Terminal } from "@earendil-works/pi-tui";
import { openRuntime } from "../src/client/connect.ts";
import { createDemoClient } from "../src/client/demo.ts";
import { App } from "../src/tui/app.ts";
import { TaskListScreen } from "../src/tui/screens/tasklist.ts";

const { Terminal: XtermHeadless } = xtermHeadless;

class HeadlessTerminal implements Terminal {
  private readonly buffer = new XtermHeadless({
    cols: 84,
    rows: 24,
    allowProposedApi: true,
  });
  private onInput: ((data: string) => void) | null = null;

  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  stop(): void {}
  write(data: string): void {
    this.buffer.write(data);
  }
  get columns(): number {
    return this.buffer.cols;
  }
  get rows(): number {
    return this.buffer.rows;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(lines: number): void {
    if (lines > 0) this.buffer.write(`\x1b[${lines}B`);
    else if (lines < 0) this.buffer.write(`\x1b[${-lines}A`);
  }
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {
    this.buffer.write("\x1b[2K");
  }
  clearFromCursor(): void {
    this.buffer.write("\x1b[0J");
  }
  clearScreen(): void {
    this.buffer.write("\x1b[2J");
  }
  setTitle(): void {}
  setProgramStatus(): void {}
  setProgress(): void {}
  async drainInput(): Promise<void> {}

  input(data: string): void {
    this.onInput?.(data);
  }
  screen(): string[] {
    const lines: string[] = [];
    for (let i = 0; i < this.buffer.rows; i++) {
      lines.push(this.buffer.buffer.active.getLine(i)?.translateToString(true) ?? "");
    }
    return lines;
  }
}

const failures: string[] = [];

function expect(condition: boolean, what: string): void {
  if (condition) {
    process.stdout.write(`  ok  ${what}\n`);
  } else {
    process.stdout.write(`FAIL  ${what}\n`);
    failures.push(what);
  }
}

function contains(screen: string[], needle: string): boolean {
  return screen.some((line) => line.includes(needle));
}

function wait(ms: number): Promise<void> {
  return delay(ms) as Promise<void>;
}

/** Polls the screen until a needle appears; slow CI/xterm parsing makes fixed sleeps unreliable. */
async function until(
  terminal: HeadlessTerminal,
  predicate: (screen: string[]) => boolean,
  ms = 25_000,
): Promise<string[]> {
  const deadline = Date.now() + ms;
  let screen: string[] = [];
  do {
    screen = terminal.screen();
    if (predicate(screen)) return screen;
    await wait(180);
  } while (Date.now() < deadline);
  return screen;
}

async function main(): Promise<void> {
  const terminal = new HeadlessTerminal();
  // same route `dovo --demo` takes: embedded server + loopback client
  const session = await openRuntime(createDemoClient(), { via: "loopback" });
  const app = new App(session.client, terminal);
  await app.start(new TaskListScreen(app));

  // real keyboards deliver text and Enter as separate reads; pi-tui's StdinBuffer
  // treats one combined chunk as a paste and inserts the \r literally.
  async function type(terminal: HeadlessTerminal, text: string): Promise<void> {
    terminal.input(text);
    await wait(250);
    terminal.input("\r");
  }

  let screen = await until(terminal, (s) => contains(s, "Fix header overflow"));
  expect(contains(screen, "dovo"), "header renders");
  expect(true, "task list shows seeded task");
  expect(contains(screen, "website · codex"), "list rows show project and provider");

  terminal.input("\r");
  await until(terminal, (s) => contains(s, "The nav wraps on narrow screens"));
  expect(true, "task history renders");

  await type(terminal, "make it resilient");
  await until(terminal, (s) => contains(s, "you  make it resilient") || contains(s, "you make it resilient"));
  expect(true, "sent user message appears");

  await until(terminal, (s) => contains(s, "agent is working"));
  expect(true, "loader shows while running");

  await until(terminal, (s) => contains(s, "▸ search"));
  expect(true, "tool activity renders");

  await until(terminal, (s) => contains(s, "needs your input"));
  expect(true, "approval request renders");

  await until(terminal, (s) => contains(s, "● waiting for you"));
  expect(true, "status flips to waiting");

  terminal.input("a");
  await until(terminal, (s) => contains(s, "Yes, apply"));
  expect(true, "approval overlay opens on 'a'");

  terminal.input("\r");
  await until(terminal, (s) => contains(s, "answered:"));
  expect(true, "approval resolves in transcript");

  // Second turn: reached a NEW pending approval while the first shows answered.
  await until(terminal, (s) => contains(s, "answered:") && contains(s, "press a to choose"));
  expect(true, "second streamed turn after approval");

  terminal.input("\x1b");
  await until(terminal, (s) => contains(s, "Fix header overflow"));
  expect(true, "escape returns to task list");

  // New task: n → project picker → agent picker → prompt → created + streaming.
  terminal.input("n");
  screen = await until(terminal, (s) => contains(s, "New task — choose project"));
  expect(contains(screen, "infra"), "project picker lists projects");

  terminal.input("\r");
  await until(terminal, (s) => contains(s, "New task — choose agent"));
  expect(true, "agent picker follows project choice");

  terminal.input("\x1b[B");
  await wait(250);
  terminal.input("\r");
  await until(terminal, (s) => contains(s, "describe the work"));
  expect(true, "prompt step after agent choice");

  await type(terminal, "teach the old dog new tricks");
  await until(terminal, (s) => contains(s, "you  teach the old dog new tricks") || contains(s, "you teach the old dog new tricks"));
  expect(true, "new task created and opens streaming");

  terminal.input("\x1b");
  await until(terminal, (s) => contains(s, "teach the old dog new tricks"));
  expect(true, "new task appears in list");

  if (failures.length > 0) {
    process.stdout.write(`\n--- final screen ---\n${terminal.screen().join("\n")}\n`);
    process.stdout.write(`\n${failures.length} failures\n`);
    await session.close();
    process.exit(1);
  }
  process.stdout.write("\nall smoke checks passed\n");
  await session.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`smoke harness crashed: ${String(error)}\n`);
  process.exit(1);
});

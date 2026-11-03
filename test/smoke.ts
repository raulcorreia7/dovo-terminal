// Drives the real App + DemoClient on a headless terminal and asserts on the
// rendered screen buffer. Run: npm run smoke

import { setTimeout as delay } from "node:timers/promises";
import { openRuntime } from "dovo-terminal/client/connect.ts";
import { createDemoClient } from "dovo-terminal/client/demo.ts";
import { App } from "dovo-terminal/tui/app.ts";
import { TaskListScreen } from "dovo-terminal/tui/screens/tasklist.ts";
import { HeadlessTerminal } from "./smoke-terminal.ts";

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
    if (predicate(screen)) {
      return screen;
    }
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
  async function type(headless: HeadlessTerminal, text: string): Promise<void> {
    headless.input(text);
    await wait(250);
    headless.input("\r");
  }

  // Screen switches resolve via dynamic import, so after any key that moves
  // between screens the next key waits for the destination's own marker:
  // humans cannot type faster than a microtask, and pressing keys blind hides
  // exactly the navigation bugs this file exists to catch.
  const onTaskList = (s: string[]) =>
    contains(s, "Fix header overflow") && contains(s, "ago") && contains(s, "n new");
  const onListWith = (title: string) => (s: string[]) => contains(s, title) && contains(s, "ago");

  let screen = await until(terminal, onTaskList);
  expect(contains(screen, "dovo"), "header renders");
  expect(true, "task list shows seeded task");
  expect(contains(screen, "website · codex"), "list rows show project and provider");

  terminal.input("\r");
  screen = await until(terminal, (s) => contains(s, "The nav wraps on narrow screens"));
  expect(contains(screen, "The nav wraps"), "task history renders");

  await type(terminal, "make it resilient");
  screen = await until(
    terminal,
    (s) => contains(s, "you  make it resilient") || contains(s, "you make it resilient"),
  );
  expect(contains(screen, "make it resilient"), "sent user message appears");

  screen = await until(terminal, (s) => contains(s, "agent is working"));
  expect(contains(screen, "agent is working"), "loader shows while running");

  screen = await until(terminal, (s) => contains(s, "▸ search"));
  expect(contains(screen, "▸ search"), "tool activity renders");

  screen = await until(terminal, (s) => contains(s, "needs your input"));
  expect(contains(screen, "needs your input"), "approval request renders");

  screen = await until(terminal, (s) => contains(s, "● waiting for you"));
  expect(contains(screen, "● waiting for you"), "status flips to waiting");

  terminal.input("a");
  screen = await until(terminal, (s) => contains(s, "Yes, apply"));
  expect(contains(screen, "Yes, apply"), "approval overlay opens on 'a'");

  terminal.input("\r");
  screen = await until(terminal, (s) => contains(s, "answered:"));
  expect(contains(screen, "answered:"), "approval resolves in transcript");

  // Second turn: reached a NEW pending approval while the first shows answered.
  screen = await until(
    terminal,
    (s) => contains(s, "answered:") && contains(s, "press a to choose"),
  );
  expect(
    contains(screen, "answered:") && contains(screen, "press a to choose"),
    "second streamed turn after approval",
  );

  terminal.input("\x1b");
  screen = await until(terminal, onTaskList);
  expect(contains(screen, "ago"), "escape returns to task list");

  // New task: n → project picker → agent picker → prompt → created + streaming.
  terminal.input("n");
  screen = await until(terminal, (s) => contains(s, "New task — choose project"));
  expect(contains(screen, "infra") && contains(screen, "website"), "project picker lists projects");

  terminal.input("\r");
  screen = await until(terminal, (s) => contains(s, "New task — choose agent"));
  expect(contains(screen, "Codex"), "agent picker follows project choice");

  terminal.input("\x1b[B");
  await wait(250);
  terminal.input("\r");
  screen = await until(terminal, (s) => contains(s, "describe the work"));
  expect(contains(screen, "describe the work"), "prompt step after agent choice");

  await type(terminal, "teach the old dog new tricks");
  screen = await until(
    terminal,
    (s) =>
      contains(s, "you  teach the old dog new tricks") ||
      contains(s, "you teach the old dog new tricks"),
  );
  expect(contains(screen, "teach the old dog"), "new task created and opens streaming");

  terminal.input("\x1b");
  screen = await until(terminal, onListWith("teach the old dog new tricks"));
  expect(contains(screen, "teach the old dog new tricks"), "new task appears in list");

  // Destructive actions must ask first: d opens the gate, a stray key cancels,
  // y performs; the header count proves the list actually changed.
  terminal.input("d");
  screen = await until(terminal, (s) => contains(s, "confirm") && contains(s, "archive"));
  expect(contains(screen, "any other key"), "archive asks for confirmation");

  terminal.input("x");
  screen = await until(terminal, (s) => !contains(s, "any other key"));
  expect(contains(screen, "teach the old dog new tricks"), "stray key cancels, task kept");

  terminal.input("d");
  await until(terminal, (s) => contains(s, "confirm") && contains(s, "archive"));
  terminal.input("y");
  screen = await until(terminal, (s) => contains(s, "1 tasks"));
  expect(!contains(screen, "teach the old dog"), "confirmed archive removes the task");

  terminal.input("D");
  screen = await until(terminal, (s) => contains(s, "delete permanently"));
  expect(contains(screen, "Fix header overflow"), "delete confirmation names the task");

  terminal.input("y");
  screen = await until(terminal, (s) => contains(s, "0 tasks"));
  expect(!contains(screen, "Fix header overflow"), "confirmed delete removes the task");

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

// Drives the real App + DemoClient on a headless terminal and asserts on the
// rendered screen buffer. Run: npm run smoke

import { setTimeout as delay } from "node:timers/promises";
import { createDemoClient } from "@dovo-terminal/client/demo.ts";
import { App } from "@dovo-terminal/tui/app.ts";
import { TaskListScreen } from "@dovo-terminal/tui/screens/tasklist.ts";
import { openRuntime } from "../src/connect.ts";
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
    await wait(25);
  } while (Date.now() < deadline);
  return screen;
}

async function main(): Promise<void> {
  const terminal = new HeadlessTerminal();
  // same route `dovo --demo` takes: embedded server + loopback client
  const session = await openRuntime(createDemoClient(), { via: "loopback" });
  let savedTheme = "";
  const shellRuns: string[] = [];
  const opened: string[] = [];
  const app = new App(session.client, {
    terminal,
    theme: "dovo",
    shellFor: (project) => ({ command: "sh", args: [], cwd: project.path }),
    checkMachines: () =>
      Promise.resolve([
        { machine: "laptop", name: "runtime", ok: true, detail: "2 project(s)" },
        {
          machine: "server",
          name: "tunnel",
          ok: false,
          detail: "down",
          next: "check the ssh host",
        },
      ]),
    openPort: (port) => {
      opened.push(`:${port.port}`);

      return Promise.resolve(`opened http://127.0.0.1:${port.port}`);
    },
    runShell: (plan) => {
      shellRuns.push(`${plan.command}@${plan.cwd}`);
    },
    onThemeChange: (setting) => {
      savedTheme = setting;
    },
  });
  await app.start(new TaskListScreen(app));

  // real keyboards deliver text and Enter as separate reads; pi-tui's StdinBuffer
  // treats one combined chunk as a paste and inserts the \r literally.
  async function type(headless: HeadlessTerminal, text: string): Promise<void> {
    headless.input(text);
    await wait(100);
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
  expect(
    contains(screen, "▾ website") && contains(screen, "1 task") && contains(screen, "codex"),
    "tasks are grouped under their project",
  );
  expect(contains(screen, "infra"), "a project without tasks still shows");

  terminal.input("t");
  screen = await until(terminal, (s) => contains(s, "Dracula"));
  expect(contains(screen, "Nord"), "theme picker lists the presets");
  terminal.input("\x1b");
  screen = await until(terminal, (s) => !contains(s, "Dracula"));
  expect(!contains(screen, "Dracula"), "escape closes the theme picker unchanged");
  expect(savedTheme === "", "closing the picker saves nothing");

  terminal.input("t");
  await until(terminal, (s) => contains(s, "Dracula"));
  for (let step = 0; step < 2; step += 1) {
    terminal.input("\x1b[B"); // opens on dovo: dovo-light, then dracula
    await wait(50);
  }
  terminal.input("\r");
  screen = await until(terminal, (s) => onTaskList(s) && !contains(s, "Dracula"));
  expect(savedTheme === "dracula", "choosing a theme reports the new setting");
  expect(onTaskList(screen), "task list is rebuilt after a theme change");

  // Fold and unfold: the first row is the "website" project header.
  terminal.input("\r");
  screen = await until(terminal, (s) => !contains(s, "Fix header overflow"));
  expect(contains(screen, "▸ website"), "enter folds the selected project");

  terminal.input("\x1b[C"); // right
  screen = await until(terminal, (s) => contains(s, "Fix header overflow"));
  expect(contains(screen, "▾ website"), "right arrow unfolds it");

  terminal.input("\x1b[B"); // down onto the task
  await wait(50);
  terminal.input("\x1b[D"); // left
  screen = await until(terminal, (s) => !contains(s, "Fix header overflow"));
  expect(contains(screen, "▸ website"), "left on a task folds its project");

  terminal.input("\x1b[D"); // left on a header: already folded, nothing happens
  terminal.input("\x1b[C"); // right: unfold
  await until(terminal, (s) => contains(s, "Fix header overflow"));

  terminal.input("/");
  await wait(80);
  terminal.input("overflow");
  screen = await until(
    terminal,
    (s) => !contains(s, "▾ website") && contains(s, "website · codex"),
  );
  expect(!contains(screen, "infra"), "search shows matching tasks across projects, flat");
  terminal.input("\x1b");
  screen = await until(terminal, (s) => contains(s, "▾ website"));
  expect(contains(screen, "infra"), "escape clears the search and restores the tree");

  // Services: pick the dev server the project is running and open it.
  terminal.input("o");
  screen = await until(terminal, (s) => contains(s, ":3000") && contains(s, "vite"));
  expect(contains(screen, "/srv/website"), "the service picker names the service and its folder");
  terminal.input("\r");
  screen = await until(terminal, (s) => contains(s, "opened http://127.0.0.1:3000"));
  expect(opened[0] === ":3000", "choosing a service opens it");

  // Machines: health of everything, failures with a next step.
  terminal.input("m");
  screen = await until(
    terminal,
    (s) => contains(s, "Machines") && contains(s, "check the ssh host"),
  );
  expect(
    contains(screen, "laptop") && contains(screen, "server"),
    "the machines report groups by machine",
  );
  terminal.input("\x1b");
  await until(terminal, onTaskList);

  // Shell key: the screen is suspended around the shell and comes back intact.
  terminal.input("s");
  await until(terminal, () => shellRuns.length > 0);
  screen = await until(terminal, onTaskList);
  expect(shellRuns[0] === "sh@/srv/website", "the shell key runs a shell in the project's folder");
  expect(onTaskList(screen), "the task list is back after the shell exits");

  // Invite: the code, then decide who is waiting.
  terminal.input("i");
  screen = await until(terminal, (s) => contains(s, "Invite a device") && contains(s, "Phone"));
  expect(contains(screen, "4829 1736"), "invite screen shows the code");
  expect(contains(screen, "wants to join"), "a waiting device is listed first");

  terminal.input("\r"); // approve the phone
  screen = await until(terminal, (s) => !contains(s, "wants to join"));
  expect(contains(screen, "Phone") && contains(screen, "Work laptop"), "approving lets it in");

  terminal.input("\x1b[A"); // the approved phone now sorts after the laptop
  await wait(50);
  terminal.input("d");
  screen = await until(terminal, (s) => contains(s, "revoke") && contains(s, "any other key"));
  expect(contains(screen, "Work laptop"), "revoking asks first");
  terminal.input("y");
  screen = await until(
    terminal,
    (s) => !(contains(s, "Work laptop") || contains(s, "any other key")),
  );
  expect(contains(screen, "Phone"), "a revoked device is gone");

  terminal.input("\x1b");
  await until(terminal, onTaskList);
  terminal.input("\x1b[B"); // header -> task
  await wait(50);
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

  expect(
    contains(screen, "OpenCode") && contains(screen, "Pi"),
    "agent picker names the harnesses",
  );

  for (let step = 0; step < 2; step += 1) {
    terminal.input("\x1b[B"); // Codex -> Claude -> OpenCode
    await wait(50);
  }
  terminal.input("\r");
  screen = await until(terminal, (s) => contains(s, "New task — choose model"));
  expect(contains(screen, "Fast") && contains(screen, "Deep"), "a harness with models asks which");

  terminal.input("\x1b[B"); // default -> Fast
  await wait(50);
  terminal.input("\r");
  screen = await until(terminal, (s) => contains(s, "describe the work"));
  expect(contains(screen, "OpenCode · Fast"), "prompt step shows the agent and model chosen");

  await type(terminal, "teach the old dog new tricks");
  screen = await until(
    terminal,
    (s) =>
      contains(s, "you  teach the old dog new tricks") ||
      contains(s, "you teach the old dog new tricks"),
  );
  expect(contains(screen, "teach the old dog"), "new task created and opens streaming");

  terminal.input("\x1b");
  screen = await until(terminal, onListWith("teach the old dog"));
  expect(contains(screen, "teach the old dog"), "new task appears in list");

  // Destructive actions must ask first: d opens the gate, a stray key cancels,
  // y performs; the header count proves the list actually changed.
  terminal.input("\x1b[B"); // header -> newest task
  await wait(50);
  terminal.input("d");
  screen = await until(terminal, (s) => contains(s, "confirm") && contains(s, "archive"));
  expect(contains(screen, "any other key"), "archive asks for confirmation");

  terminal.input("x");
  screen = await until(terminal, (s) => !contains(s, "any other key"));
  expect(contains(screen, "teach the old dog"), "stray key cancels, task kept");

  terminal.input("d");
  await until(terminal, (s) => contains(s, "confirm") && contains(s, "archive"));
  terminal.input("y");
  screen = await until(terminal, (s) => contains(s, "1 tasks · 2 projects"));
  expect(!contains(screen, "teach the old dog"), "confirmed archive removes the task");

  terminal.input("\x1b[B"); // header -> the remaining task
  await wait(50);
  terminal.input("D");
  screen = await until(terminal, (s) => contains(s, "delete permanently"));
  expect(contains(screen, "Fix header overflow"), "delete confirmation names the task");

  terminal.input("y");
  screen = await until(terminal, (s) => contains(s, "0 tasks · 2 projects"));
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

// The demo's fiction, as data: fixtures the workbench shows and the scripted
// agent turn it answers with. Scheduling lives in demo.ts; this file only
// says what happens, never when.

// Deterministic fake runtime: streams scripted agent turns with the same event
// discipline as the real client. Serves `dovo serve --demo`, `dovo --demo`,
// and the TUI smoke test - the app runs on it alone, no Dovo required.

import type { ConversationItem } from "dovo-terminal/protocol/workspace.ts";

export const DEMO_PROJECTS = [
    { id: "p-alpha", name: "website", path: "/srv/website" },
    { id: "p-beta", name: "infra", path: "/srv/infra" },
];

export const DEMO_PROVIDERS = [
    { id: "codex", label: "Codex" },
    { id: "claude", label: "Claude" },
];

/** The one pre-seeded conversation the list and history show on start. */
const DEMO_SEED_TASK_ID = "t-old";
export const DEMO_SEED_TASK = {
    id: DEMO_SEED_TASK_ID,
    projectId: "p-alpha",
    title: "Fix header overflow on mobile",
    status: "idle" as const,
    provider: "codex",
    ageMs: 3_600_000,
};
export const DEMO_SEED_ITEMS: ConversationItem[] = [
    { kind: "user", id: "i1", text: "The nav wraps on narrow screens" },
    {
        kind: "assistant",
        id: "i2",
        text: "Fixed by constraining the flex row.\n\n```css\nnav { flex-wrap: nowrap; }\n```",
        done: true,
    },
];

// Pacing values are arbitrary; their order is not.
export const PACE = {
    toolStartMs: 300,
    toolResolveMs: 700,
    chunkStepMs: 350,
    approvalAfterLastChunkMs: 400,
} as const;

/** One scheduled assistant-text frame; precomputed so timers capture values. */
export interface ReplyFrame {
    delay: number;
    text: string;
    first: boolean;
}

interface ReplyPlan {
    toolStart: { delay: number; detail: string };
    toolResolve: { delay: number; detail: string };
    frames: ReplyFrame[];
    /** Full answer text + the approval that ends the turn. */
    finalText: string;
    approvalDelay: number;
}

/** The scripted turn: search tool, streamed findings, an approval to answer. */
export function planReply(prompt: string): ReplyPlan {
    const chunks = [
        "Working on it.\n\n",
        `Here is what I found about **${prompt.slice(0, 40)}**:\n\n`,
        "- inspected the project files\n",
        "- checked recent diffs\n\n",
        "The change is straightforward; I will apply it once you approve.\n",
    ];
    let delay = PACE.toolStartMs;
    const toolStart = { delay, detail: `pattern: ${prompt.slice(0, 24)}` };
    delay += PACE.toolResolveMs;
    const toolResolve = { delay, detail: "12 matches" };

    const frames: ReplyFrame[] = [];
    let partial = "";
    let first = true;
    for (const chunk of chunks) {
        delay += PACE.chunkStepMs;
        partial += chunk;
        frames.push({ delay, text: partial, first });
        first = false;
    }
    return {
        toolStart,
        toolResolve,
        frames,
        finalText: partial,
        approvalDelay: delay + PACE.approvalAfterLastChunkMs,
    };
}

/** The approval the scripted turn ends with (ids are filled by the caller). */
export const DEMO_APPROVAL = {
    title: "Apply change to main?",
    detail: "git apply --index 1-file patch",
    options: [
        { id: "yes", label: "Yes, apply" },
        { id: "no", label: "No, keep planning" },
    ],
} as const;

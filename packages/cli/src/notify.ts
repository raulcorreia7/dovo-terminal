// Tell a Teams channel when a task needs you or has finished, so you can leave
// the terminal. Best effort by design: a failed post never disturbs the app.
import type { RuntimeClient } from "@dovo-terminal/protocol/runtime-client.ts";
import type { TaskStatus } from "@dovo-terminal/protocol/workspace.ts";

export type Send = (webhook: string, text: string) => Promise<void>;

/** A webhook must be https: it carries a secret in its URL. */
export function isSafeWebhook(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** The message shape Teams "workflow" webhooks accept: an adaptive card in a message. */
export function teamsPayload(text: string): object {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          version: "1.4",
          body: [{ type: "TextBlock", text, wrap: true }],
        },
      },
    ],
  };
}

async function postToTeams(webhook: string, text: string): Promise<void> {
  await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(teamsPayload(text)),
  });
}

/** What a change of status is worth saying, if anything. */
export function describeChange(previous: TaskStatus | undefined, next: TaskStatus): string | null {
  if (next === "waiting" && previous !== "waiting") {
    return "needs your input";
  }
  if (next === "idle" && previous === "running") {
    return "finished";
  }

  return null;
}

/** Watch a client's frames and post the changes worth knowing. Returns a stop function. */
export function startTeamsNotifier(
  client: Pick<RuntimeClient, "subscribe" | "listTasks">,
  webhook: string,
  send: Send = postToTeams,
): () => void {
  const last = new Map<string, TaskStatus>();
  const target = { client, webhook, send };

  return client.subscribe((frame) => {
    if (frame.type !== "event" || frame.event.type !== "status") {
      return;
    }
    const { taskId, status } = frame.event;
    const said = describeChange(last.get(taskId), status);
    last.set(taskId, status);
    if (said) {
      void announce(target, taskId, said);
    }
  });
}

interface Target {
  client: Pick<RuntimeClient, "listTasks">;
  webhook: string;
  send: Send;
}

async function announce(target: Target, taskId: string, said: string): Promise<void> {
  try {
    const tasks = await target.client.listTasks();
    const title = tasks.find((task) => task.id === taskId)?.title || "A task";
    await target.send(target.webhook, `${title} ${said}`);
  } catch {
    // best effort: the terminal matters more than the notification
  }
}

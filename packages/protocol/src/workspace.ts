// Workspace view model shared by the local runtime server and the TUI.
// Types are derived from these zod schemas: one source of truth, validated
// whenever JSON crosses the loopback boundary. Field names mirror Dovo
// concepts, never Dovo's raw wire shapes (adapters map those).
import { z } from "zod";

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const TaskStatusSchema = z.enum([
  "running", // a run is in flight
  "waiting", // paused on an approval or question
  "idle", // turn finished, resumable
  "error",
  "unknown",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const AgentProviderSchema = z.object({
  id: z.string(),
  label: z.string(),
});
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

export const TaskSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: TaskStatusSchema,
  provider: z.string(),
  updatedAt: z.number(),
  activeRunId: z.string().optional(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

// A task title is the prompt's first line, capped so list rows stay stable.
export const TASK_TITLE_MAX_CHARS = 72;

/** A client paired with the runtime, or one that is asking to be. */
export const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  pending: z.boolean(),
});
export type Device = z.infer<typeof DeviceSchema>;

/** What the owner shows a new device: a short-lived code to enter there. */
export const InviteSchema = z.object({
  code: z.string(),
  /** When the code stops working, if the runtime says. */
  expiresAt: z.string().optional(),
});
export type Invite = z.infer<typeof InviteSchema>;

/** Approve or deny a waiting device, or revoke a paired one. */
export const DeviceDecisionSchema = z.enum(["approve", "deny", "revoke"]);
export type DeviceDecision = z.infer<typeof DeviceDecisionSchema>;

/**
 * A web service a project's process is listening on, on the machine the project
 * lives on. `pid` and `started` identify the process, so a port that has since
 * been taken over by something else can be told apart before it is opened.
 */
export const ServicePortSchema = z.object({
  port: z.number().int().min(1).max(65_535),
  command: z.string(),
  folder: z.string(),
  projectId: z.string(),
  pid: z.number().int(),
  started: z.string(),
});
export type ServicePort = z.infer<typeof ServicePortSchema>;

/** One model a harness can run. `id` is what the runtime expects; `label` is for people. */
export const ModelOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

export const CreateTaskInputSchema = z.object({
  projectId: z.string(),
  providerId: z.string(),
  /** Omitted (or empty) means the harness's own default model. */
  model: z.string().optional(),
  prompt: z.string(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

// One rendered entry in a task conversation. Append-only: streaming updates
// replace the trailing assistant item's text, never rewrite history.
const ItemIdFields = { id: z.string() };
export const ConversationItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), ...ItemIdFields, text: z.string() }),
  z.object({
    kind: z.literal("assistant"),
    ...ItemIdFields,
    text: z.string(),
    done: z.boolean(),
  }),
  z.object({
    kind: z.literal("tool"),
    ...ItemIdFields,
    name: z.string(),
    detail: z.string(),
    state: z.enum(["running", "ok", "error"]),
  }),
  z.object({
    kind: z.literal("approval"),
    ...ItemIdFields,
    title: z.string(),
    detail: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string() })),
    answered: z.string().nullable(),
  }),
  z.object({ kind: z.literal("system"), ...ItemIdFields, text: z.string() }),
]);
export type ConversationItem = z.infer<typeof ConversationItemSchema>;

export const TaskHistorySchema = z.object({
  items: z.array(ConversationItemSchema),
  status: TaskStatusSchema,
  activeRunId: z.string().optional(),
});
export type TaskHistory = z.infer<typeof TaskHistorySchema>;

// Dovo's own HTTP wire shapes (packages/protocol upstream) as zod schemas.
// These describe what the REAL Dovo runtime sends today (audited at commit
// a3297a9); the rest of the adapter never touches raw JSON.
//
// Every object is loose: Dovo adds fields freely, so unknown keys must pass
// through untouched and only the fields we act on are checked. Identity
// fields stay required - a task without an id or a repo without a path is a
// contract violation worth surfacing, not a silent skip.
import { z } from "zod";

const Loose = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);

export const WireMessageSchema = Loose({
  id: z.string(),
  role: z.string(),
  text: z.string(),
  createdAt: z.string().optional(),
});
export type WireMessage = z.infer<typeof WireMessageSchema>;

export const WireTaskSchema = Loose({
  id: z.string(),
  title: z.string().optional(),
  repositoryId: z.string().optional(),
  agentId: z.string().optional(),
  harness: Loose({ provider: z.string().optional() }).optional(),
  status: z.string().optional(),
  activeRunId: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  archivedAt: z.string().nullable().optional(),
  messages: z.array(WireMessageSchema).optional(),
});
export type WireTask = z.infer<typeof WireTaskSchema>;

export const WireApprovalSchema = Loose({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  detail: z.string().optional(),
  scopes: Loose({ session: z.boolean().optional(), always: z.boolean().optional() }).optional(),
});
export type WireApproval = z.infer<typeof WireApprovalSchema>;

export const WireQuestionSchema = Loose({
  id: z.string(),
  taskId: z.string(),
  prompt: Loose({
    title: z.string().optional(),
    questions: z.array(
      Loose({
        id: z.string(),
        question: z.string(),
        header: z.string().optional(),
        options: z.array(Loose({ value: z.string(), label: z.string() })).optional(),
        custom: z.boolean().optional(),
      }),
    ),
  }),
});
export type WireQuestion = z.infer<typeof WireQuestionSchema>;

export const SnapshotSchema = Loose({
  runtimeInstanceId: z.string().optional(),
  approvals: z.array(WireApprovalSchema).optional(),
  questions: z.array(WireQuestionSchema).optional(),
  workspace: Loose({
    repositories: z.array(Loose({ id: z.string(), name: z.string(), path: z.string() })).optional(),
    agents: z.array(Loose({ id: z.string(), name: z.string(), provider: z.string() })).optional(),
    tasks: z.array(WireTaskSchema).optional(),
  }).optional(),
});
export type WireSnapshot = z.infer<typeof SnapshotSchema>;

export const AgentAvailabilitySchema = Loose({ id: z.string(), available: z.boolean() });
export const AgentAvailabilityListSchema = z.array(AgentAvailabilitySchema);

export const ActivityEventSchema = Loose({
  id: z.string(),
  time: z.string().optional(),
  kind: z.string().optional(),
  scope: z.string().optional(),
  summary: z.string().optional(),
  payload: z.string().optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

// POST /api/activity replies with an object envelope, never a bare array.
export const ActivityPageSchema = Loose({ events: z.array(ActivityEventSchema).optional() });

// Compacted tool payload (activity.ts): JSON string inside ActivityEvent.payload.
export const ToolPayloadSchema = Loose({
  status: z.string().optional(),
  text: z.string().optional(),
  presentation: Loose({
    input: z.unknown().optional(),
    detail: z.unknown().optional(),
    diff: z.unknown().optional(),
  }).optional(),
});

export const ActivityEventListSchema = z.array(ActivityEventSchema);

// WS activity-delta frames: field- replacements plus payload text edits.
export const MessageTextDeltaSchema = Loose({ append: z.string() });
export const PayloadTextDeltaSchema = Loose({
  length: z.number(),
  offset: z.number(),
  remove: z.number(),
  insert: z.string(),
});

export const ActivityDeltaSchema = Loose({
  changes: z
    .array(
      Loose({
        fields: ActivityEventSchema.optional(),
        payload: z.union([z.string(), PayloadTextDeltaSchema]).optional(),
      }),
    )
    .optional(),
});
export type ActivityDelta = z.infer<typeof ActivityDeltaSchema>;

// Sync-channel frame envelope: the payload of each case is parsed by its own
// schema (SnapshotSchema, SyncDeltaSchema, ActivityEventListSchema, ...).
export const SyncFrameSchema = Loose({ type: z.string() });
export type SyncFrame = z.infer<typeof SyncFrameSchema>;

// Sync-channel payloads: snapshot/selection/delta frames, the consumed subset.
// Message field patches carry any subset of messageSchema.
const MessagePatchSchema = Loose({
  id: z.string(),
  role: z.string().optional(),
  text: z.string().optional(),
});
export const MessageChangeSchema = Loose({
  fields: MessagePatchSchema.optional(),
  text: z.union([z.string(), MessageTextDeltaSchema]).optional(),
});
export type MessageChange = z.infer<typeof MessageChangeSchema>;
export const SyncTaskChangeSchema = Loose({
  id: z.string(),
  fields: z.record(z.string(), z.unknown()).optional(),
  fieldDelta: Loose({
    values: z.record(z.string(), z.unknown()).optional(),
    removed: z.array(z.string()).optional(),
  }).optional(),
  messages: Loose({ changes: z.array(MessageChangeSchema).optional() }).optional(),
});
export type SyncTaskChange = z.infer<typeof SyncTaskChangeSchema>;
export const SyncDeltaSchema = Loose({
  state: Loose({
    approvals: z.array(WireApprovalSchema).optional(),
    questions: z.array(WireQuestionSchema).optional(),
  }).optional(),
  workspace: Loose({
    tasks: Loose({ changes: z.array(SyncTaskChangeSchema).optional() }).optional(),
  }).optional(),
});
export type SyncDelta = z.infer<typeof SyncDeltaSchema>;

// The workspace PATCH verdict: a 200 can still mean "rejected".
export const MutationOutcomeSchema = Loose({
  outcome: z.string().optional(),
  reason: z.string().optional(),
});

export const SyncTicketSchema = Loose({ ticket: z.string() });

// Request bodies the client must produce (documented in dovo-api-contract.md).
// Built and asserted through these same schemas - one contract, two ends.
export const MessageBodySchema = z.object({
  id: z.string(),
  messageId: z.string(),
  text: z.string().min(1),
});
export type MessageBody = z.infer<typeof MessageBodySchema>;

export const CancelTaskBodySchema = z.object({
  id: z.string(),
  runId: z.string(),
});
export type CancelTaskBody = z.infer<typeof CancelTaskBodySchema>;

export const ApprovalBodySchema = z.object({
  id: z.string(),
  allow: z.boolean(),
  decision: z.enum(["approve", "session", "always", "deny"]),
});
export type ApprovalBody = z.infer<typeof ApprovalBodySchema>;

export const LifecycleBodySchema = z.object({
  id: z.string(),
  action: z.enum(["archive", "restore", "delete"]),
});
export type LifecycleBody = z.infer<typeof LifecycleBodySchema>;

export const AnswerBodySchema = z.object({
  id: z.string(),
  answers: z.record(z.string(), z.array(z.string())),
});
export type AnswerBody = z.infer<typeof AnswerBodySchema>;

// Task-draft body for workspace creates: complete metadata at creation time.
export const WireHarnessDraftSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoning: z.string(),
  serviceTier: z.string(),
  instructions: z.string(),
  permission: z.string(),
  endpoint: z.string(),
});
export type WireHarnessDraft = z.infer<typeof WireHarnessDraftSchema>;

export const WireTaskDraftSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  title: z.string(),
  agentId: z.string(),
  harness: WireHarnessDraftSchema.optional(),
  execution: z.literal("main"),
  status: z.literal("draft"),
  createdAt: z.string(),
  messages: z.tuple([]),
  files: z.tuple([]),
  draft: z.string(),
  example: z.boolean(),
});
export type WireTaskDraft = z.infer<typeof WireTaskDraftSchema>;

export const CreateTaskBodySchema = z.object({
  collection: z.literal("tasks"),
  id: z.string(),
  changes: z.unknown(),
  create: WireTaskDraftSchema,
});
export type CreateTaskBody = z.infer<typeof CreateTaskBodySchema>;

// Input frames accepted on the sync channel (connection.ts upstream):
// watch carries the task list and activity scopes as arrays.
export const SyncInputFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("resume"),
    epoch: z.string().optional(),
    sequence: z.number().int().optional(),
  }),
  z.object({ type: z.literal("watch"), tasks: z.array(z.string()), scopes: z.array(z.string()) }),
]);
export type SyncInputFrame = z.infer<typeof SyncInputFrameSchema>;

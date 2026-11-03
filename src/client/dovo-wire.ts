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
export const ActivityDeltaSchema = Loose({
  changes: z
    .array(
      Loose({
        fields: ActivityEventSchema.optional(),
        payload: z
          .union([z.string(), Loose({ length: z.number(), offset: z.number(), remove: z.number(), insert: z.string() })])
          .optional(),
      }),
    )
    .optional(),
});
export type ActivityDelta = z.infer<typeof ActivityDeltaSchema>;

// The workspace PATCH verdict: a 200 can still mean "rejected".
export const MutationOutcomeSchema = Loose({
  outcome: z.string().optional(),
  reason: z.string().optional(),
});

export const SyncTicketSchema = Loose({ ticket: z.string() });

// A plan is the only thing the planner's words can become: a short, validated
// list of steps for named workers. Anything outside these bounds is rejected
// before a single task starts.
import { DovoError } from "@dovo-terminal/protocol/errors.ts";
import { z } from "zod";

export const MAX_STEPS = 8;
export const MAX_GOAL_CHARS = 4000;
export const MAX_TOTAL_CHARS = 20_000;

const StepSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/u, "step ids are lowercase letters, digits and dashes"),
  worker: z.string().min(1),
  goal: z.string().min(1).max(MAX_GOAL_CHARS),
  dependsOn: z.array(z.string()).default([]),
});
export type Step = z.infer<typeof StepSchema>;

const PlanSchema = z.strictObject({ steps: z.array(StepSchema).min(1).max(MAX_STEPS) });
export type Plan = z.infer<typeof PlanSchema>;

/** Check a plan against the schema, the known workers, and the dependency graph. */
export function validatePlan(raw: unknown, workers: readonly string[]): Plan {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DovoError(
      `the plan is not valid: ${issue?.path.join(".") || "plan"} ${issue?.message ?? ""}`,
    );
  }
  const { steps } = parsed.data;
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) {
    throw new DovoError("the plan is not valid: step ids must be unique");
  }
  if (steps.reduce((sum, step) => sum + step.goal.length, 0) > MAX_TOTAL_CHARS) {
    throw new DovoError(`the plan is too large (over ${MAX_TOTAL_CHARS} characters of goals)`);
  }
  for (const step of steps) {
    if (!workers.includes(step.worker)) {
      throw new DovoError(`the plan names an unknown worker "${step.worker}"`);
    }
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency) || dependency === step.id) {
        throw new DovoError(
          `step "${step.id}" depends on "${dependency}", which is not another step`,
        );
      }
    }
  }
  stages(parsed.data);

  return parsed.data;
}

/** Steps grouped so each group depends only on earlier ones. Throws on a cycle. */
export function stages(plan: Plan): Step[][] {
  const done = new Set<string>();
  const levels: Step[][] = [];
  let remaining = [...plan.steps];
  while (remaining.length > 0) {
    const ready = remaining.filter((step) => step.dependsOn.every((id) => done.has(id)));
    if (ready.length === 0) {
      throw new DovoError("the plan is not valid: its steps depend on each other in a circle");
    }
    levels.push(ready);
    for (const step of ready) {
      done.add(step.id);
    }
    remaining = remaining.filter((step) => !done.has(step.id));
  }

  return levels;
}

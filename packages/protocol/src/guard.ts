import type { z } from "zod";

/**
 * The single validation entry point: parse, or throw.
 *
 * Every external input (HTTP bodies, WS frames, files on disk) goes through a
 * schema via this function - no per-shape validate/tryParse wrappers. A throw
 * is the default, correct outcome: it means the producer broke the contract.
 * Callers that must tolerate junk (a live frame stream, a half-written config
 * file) catch at the exact drop point, where dropping is the documented
 * behavior rather than a hidden fallback.
 */
export function guard<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  return schema.parse(input);
}

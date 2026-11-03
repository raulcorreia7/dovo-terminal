import { DovoError } from "./errors.ts";

/** The runtime cannot do this at all (not "it failed"): the server answers 501. */
export class UnsupportedError extends DovoError {}

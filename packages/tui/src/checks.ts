/** One line of the health report: a machine (or the app) and whether a thing works. */
export interface Check {
  /** The machine this is about, or "dovo" for app-wide checks. */
  machine: string;
  name: string;
  ok: boolean;
  detail: string;
  /** What to do about it; only for failures. */
  next?: string;
}

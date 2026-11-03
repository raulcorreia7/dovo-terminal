// The flags every command can receive, as parseArgs returns them.
export interface Options {
  [key: string]: string | boolean | undefined;
  url?: string;
  token?: string;
  profile?: string;
  demo?: boolean;
  server?: string;
  local?: boolean;
  port?: string;
  theme?: string;
  all?: boolean;
  a2a?: string;
  older?: string;
  yes?: boolean;
  rotate?: boolean;
  agent?: boolean;
  planner?: string;
  deep?: boolean;
  worker?: string;
  ssh?: string;
}

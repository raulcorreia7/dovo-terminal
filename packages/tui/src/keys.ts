// The task list's keys. Each action has one default; a config `keys` map may
// replace any of them. Everything that shows or matches a key goes through here,
// so the help screen can never disagree with what actually works.
import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

export const LIST_KEYS = {
  new: "n",
  refresh: "r",
  theme: "t",
  invite: "i",
  shell: "s",
  open: "o",
  machines: "m",
  search: "/",
  help: "?",
  archive: "d",
  delete: "shift+d",
  unfold: "right",
  fold: "left",
} as const;

export type ListAction = keyof typeof LIST_KEYS;
export type KeyOverrides = Partial<Record<ListAction, string>>;

export function isListAction(name: string): name is ListAction {
  return name in LIST_KEYS;
}

export function keyFor(action: ListAction, overrides: KeyOverrides): string {
  return overrides[action] ?? LIST_KEYS[action];
}

/** Does this input press the key bound to the action? */
export function pressed(data: string, action: ListAction, overrides: KeyOverrides): boolean {
  // A user-written key id is checked by pi-tui's matcher, which simply never
  // matches one it does not know.
  return matchesKey(data, keyFor(action, overrides) as KeyId);
}

const SHOWN: Readonly<Record<string, string>> = { right: "→", left: "←", "shift+d": "D" };

/** How a key reads in the help screen. */
export function shown(key: string): string {
  return SHOWN[key] ?? key;
}

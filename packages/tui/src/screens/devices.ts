import { errorMessage } from "@dovo-terminal/protocol/errors.ts";
import type { DeviceDirectory } from "@dovo-terminal/protocol/runtime-client.ts";
import type { Device, Invite } from "@dovo-terminal/protocol/workspace.ts";
import {
  type Component,
  Key,
  matchesKey,
  type OverlayHandle,
  type SelectItem,
  SelectList,
  VStack,
} from "@earendil-works/pi-tui";
import { type App, note } from "../app.ts";
import { ConfirmPrompt } from "../confirm.ts";
import { LineText } from "../line.ts";
import type { Screen } from "../screen.ts";
import { colors, selectListTheme, t } from "../theme/index.ts";

const POLL_MS = 2000;

const CODE_CHUNK = /(?<chunk>.{4})(?=.)/gu;

/** "48291736" reads better as "4829 1736". */
function groupCode(code: string): string {
  return code.replace(CODE_CHUNK, "$<chunk> ");
}

/** Whoever is waiting for an answer goes on top, whatever order the runtime used. */
function waitingFirst(devices: readonly Device[]): Device[] {
  return [...devices].sort((a, b) => Number(b.pending) - Number(a.pending));
}

/** Invite a device with a code, and decide who is waiting. */
export class DevicesScreen implements Screen {
  readonly id = "devices";
  private readonly app: App;
  private readonly root = new VStack();
  private readonly invite = new LineText("");
  private list: SelectList | null = null;
  private devices: Device[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private confirmOverlay: OverlayHandle | null = null;

  constructor(app: App) {
    this.app = app;
  }

  recreate(): Screen {
    return new DevicesScreen(this.app);
  }

  /** The runtime's device ability, or nothing if it has none. */
  private get directory(): DeviceDirectory | undefined {
    return this.app.client.devices;
  }

  build(): { root: VStack; focus?: Component | undefined } {
    if (!this.directory) {
      this.invite.setText(t(" this runtime cannot manage devices", colors.dim));

      this.compose();

      return { root: this.root };
    }
    void this.openInvite();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);

    return { root: this.root, focus: this.compose() };
  }

  destroy(): void {
    clearInterval(this.timer);
    this.confirmOverlay?.hide();
  }

  handleKey(data: string): boolean {
    if (this.app.tui.hasOverlay()) {
      return false; // the confirmation on top owns the keys
    }
    if (matchesKey(data, Key.escape)) {
      void import("./tasklist.ts").then(({ TaskListScreen }) =>
        this.app.show(new TaskListScreen(this.app)),
      );
      return true;
    }
    if (matchesKey(data, "d")) {
      this.dismissSelected();
      return true;
    }

    return false;
  }

  private async openInvite(): Promise<void> {
    try {
      const invite = await this.directory?.invite();
      if (invite) {
        this.invite.setText(this.inviteText(invite));
      }
    } catch (error) {
      this.invite.setText(t(` no invite: ${errorMessage(error)}`, colors.error));
    }
    this.app.tui.requestRender();
  }

  private inviteText(invite: Invite): string {
    const expiry = invite.expiresAt ? t(`  (expires ${invite.expiresAt})`, colors.dim) : "";

    return (
      t(" invite code  ", colors.muted) +
      t(groupCode(invite.code), colors.accent, { bold: true }) +
      t("  enter it in Dovo on the new device", colors.muted) +
      expiry
    );
  }

  private async refresh(): Promise<void> {
    try {
      this.devices = waitingFirst((await this.directory?.list()) ?? []);
    } catch (error) {
      this.app.statusNote = `devices failed: ${errorMessage(error)}`;
    }
    this.rebuildList();
    this.app.refreshHeader();
    this.app.tui.requestRender();
  }

  /** Waiting devices first; Enter on one lets it in. */
  private rebuildList(): void {
    const previous = this.list?.getSelectedItem()?.value;
    const items: SelectItem[] = this.devices.map((device) => ({
      value: device.id,
      label: this.deviceLabel(device),
      description: this.deviceHint(device),
    }));
    const list = new SelectList(
      items,
      Math.max(5, this.app.tui.terminal.rows - 8),
      selectListTheme,
    );
    list.setSelectedIndex(
      Math.max(
        0,
        items.findIndex((item) => item.value === previous),
      ),
    );
    list.onSelect = (item) => void this.approve(item.value);
    list.onCancel = () => this.leave();
    this.list = list;
    const focus = this.compose();
    if (!this.app.tui.hasOverlay()) {
      this.app.tui.setFocus(focus);
    }
  }

  private compose(): Component {
    this.root.clear();
    this.root.addChild(new LineText(t(" Invite a device", colors.accent, { bold: true })), {
      basis: "auto",
    });
    this.root.addChild(this.invite, { basis: "auto" });
    if (!this.list || this.devices.length === 0) {
      const empty = note(
        "no devices yet. enter the code on a new device to ask for access",
        colors.dim,
      );
      this.root.addChild(empty, { grow: 1, basis: 0 });

      return empty;
    }
    this.root.addChild(this.list, { grow: 1, basis: 0 });

    return this.list;
  }

  private deviceLabel(device: Device): string {
    if (device.pending) {
      return `${t("●", colors.warn)} ${device.name}`;
    }

    return `${t("●", colors.ok)} ${device.name}`;
  }

  private deviceHint(device: Device): string {
    if (device.pending) {
      return "wants to join · enter approves · d denies";
    }

    return "paired · d revokes";
  }

  private selectedDevice(): Device | undefined {
    const value = this.list?.getSelectedItem()?.value;

    return this.devices.find((device) => device.id === value);
  }

  private async approve(deviceId: string): Promise<void> {
    const device = this.devices.find((entry) => entry.id === deviceId);
    if (device?.pending) {
      await this.decide(deviceId, "approve");
    }
  }

  /** Deny a waiting device straight away; revoking a paired one asks first. */
  private dismissSelected(): void {
    const device = this.selectedDevice();
    if (!device) {
      return;
    }
    if (device.pending) {
      void this.decide(device.id, "deny");

      return;
    }
    if (this.confirmOverlay) {
      return;
    }
    const prompt = new ConfirmPrompt(
      `${t("revoke", colors.error, { bold: true })} ${t(`"${device.name}"`, colors.text, { bold: true })}?`,
    );
    prompt.onAnswer = (accept) => {
      this.confirmOverlay?.hide();
      this.confirmOverlay = null;
      this.app.tui.requestRender();
      if (accept) {
        void this.decide(device.id, "revoke");
      }
    };
    this.confirmOverlay = this.app.tui.showOverlay(prompt, { width: "70%", anchor: "center" });
    this.app.tui.requestRender();
  }

  private async decide(deviceId: string, decision: "approve" | "deny" | "revoke"): Promise<void> {
    try {
      await this.directory?.decide(deviceId, decision);
    } catch (error) {
      this.app.statusNote = `${decision} failed: ${errorMessage(error)}`;
    }
    await this.refresh();
  }

  private leave(): void {
    void import("./tasklist.ts").then(({ TaskListScreen }) =>
      this.app.show(new TaskListScreen(this.app)),
    );
  }
}

import { DovoError } from "@dovo-terminal/protocol/errors.ts";
import type { DeviceDirectory } from "@dovo-terminal/protocol/runtime-client.ts";
import type { Device, DeviceDecision, Invite } from "@dovo-terminal/protocol/workspace.ts";
import { DEMO_DEVICES, DEMO_INVITE_CODE } from "./demo-script.ts";

/** The demo runtime's paired and waiting devices, in memory. */
export class DemoDevices implements DeviceDirectory {
  private devices: Device[] = DEMO_DEVICES.map((device) => ({ ...device }));

  async list(): Promise<Device[]> {
    return this.devices.map((device) => ({ ...device }));
  }

  async invite(): Promise<Invite> {
    return { code: DEMO_INVITE_CODE };
  }

  async decide(deviceId: string, decision: DeviceDecision): Promise<void> {
    if (!this.devices.some((device) => device.id === deviceId)) {
      throw new DovoError(`unknown device ${deviceId}`);
    }
    if (decision === "approve") {
      this.devices = this.devices.map((device) =>
        device.id === deviceId ? { ...device, pending: false } : device,
      );
    } else {
      this.devices = this.devices.filter((device) => device.id !== deviceId);
    }
  }
}

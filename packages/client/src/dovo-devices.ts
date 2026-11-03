// Device pairing, owner side: show a code, list who is paired or waiting,
// approve, deny or revoke. Shapes follow docs/dovo-api-contract.md; a device
// entry is documented only by its id, so the name is optional on the wire.
import { guard } from "@dovo-terminal/protocol/guard.ts";
import type { DeviceDirectory } from "@dovo-terminal/protocol/runtime-client.ts";
import type { Device, DeviceDecision, Invite } from "@dovo-terminal/protocol/workspace.ts";
import type { WireDevice, WireSnapshot } from "./dovo-wire.ts";
import { InviteReplySchema } from "./dovo-wire.ts";

type Request = (path: string, init?: RequestInit) => Promise<unknown>;

function toDevices(entries: readonly WireDevice[] | undefined, pending: boolean): Device[] {
  return (entries ?? []).map((entry) => ({
    id: entry.id,
    name: entry.name ?? entry.id,
    pending,
  }));
}

export class DeviceDesk implements DeviceDirectory {
  private readonly request: Request;
  private readonly snapshot: (query: string) => Promise<WireSnapshot>;

  constructor(request: Request, snapshot: (query: string) => Promise<WireSnapshot>) {
    this.request = request;
    this.snapshot = snapshot;
  }

  /** Waiting devices first. A runtime that hides them from this caller reports none. */
  async list(): Promise<Device[]> {
    const snapshot = await this.snapshot("?scope=overview");

    return [...toDevices(snapshot.pendingDevices, true), ...toDevices(snapshot.devices, false)];
  }

  async invite(): Promise<Invite> {
    const reply = guard(InviteReplySchema, await this.post("/api/pair/code", {}));
    if (reply.expiresAt === undefined) {
      return { code: reply.code };
    }

    return { code: reply.code, expiresAt: String(reply.expiresAt) };
  }

  async decide(deviceId: string, decision: DeviceDecision): Promise<void> {
    if (decision === "revoke") {
      await this.post("/api/devices/revoke", { id: deviceId });
    } else {
      await this.post("/api/pair/approve", { id: deviceId, allow: decision === "approve" });
    }
  }

  private post(path: string, body: object): Promise<unknown> {
    return this.request(path, { method: "POST", body: JSON.stringify(body) });
  }
}

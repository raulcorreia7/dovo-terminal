// Many machines behind one RuntimeClient. Each machine is a runtime (a saved
// profile); the TUI sees one merged workspace and cannot tell the difference.
// Ids are namespaced `<id>@<machine>` so two machines can both have a project
// called "p1"; every call is routed to the machine its id names.
import { DovoError } from "@dovo-terminal/protocol/errors.ts";
import type {
  ArchiveStore,
  DeviceDirectory,
  PortDirectory,
  RuntimeClient,
} from "@dovo-terminal/protocol/runtime-client.ts";
import type {
  ConnectionPhase,
  SyncFrame,
  SyncListener,
  Unsubscribe,
} from "@dovo-terminal/protocol/sync.ts";
import { SyncSink } from "@dovo-terminal/protocol/sync-sink.ts";
import { UnsupportedError } from "@dovo-terminal/protocol/unsupported-error.ts";
import type {
  AgentProvider,
  CreateTaskInput,
  Device,
  DeviceDecision,
  Invite,
  ModelOption,
  Project,
  ServicePort,
  TaskHistory,
  TaskSummary,
} from "@dovo-terminal/protocol/workspace.ts";

export interface Machine {
  name: string;
  client: RuntimeClient;
}

const SEPARATOR = "@";

function scoped(id: string, machine: string): string {
  return `${id}${SEPARATOR}${machine}`;
}

/** Order in which one phase beats another when machines disagree. */
const PHASE_RANK: Record<ConnectionPhase, number> = {
  online: 0,
  reconnecting: 1,
  connecting: 2,
  offline: 3,
};

export function createFederatedClient(machines: readonly Machine[]): RuntimeClient {
  const names = machines.map((machine) => machine.name);
  if (machines.length === 0 || new Set(names).size !== names.length) {
    throw new DovoError("a federation needs at least one machine, each with its own name");
  }
  if (names.some((name) => name.includes(SEPARATOR))) {
    throw new DovoError(`machine names cannot contain "${SEPARATOR}"`);
  }

  return new FederatedClient(machines);
}

class FederatedClient implements RuntimeClient {
  private readonly machines: readonly Machine[];
  private readonly sink = new SyncSink();
  private readonly phases = new Map<string, ConnectionPhase>();
  private unsubscribers: Unsubscribe[] = [];
  private focused: string | null = null;
  readonly archive: ArchiveStore | undefined;
  readonly devices: DeviceDirectory | undefined;
  readonly ports: PortDirectory | undefined;

  constructor(machines: readonly Machine[]) {
    this.machines = machines;
    const any = (has: (client: RuntimeClient) => unknown) =>
      machines.some((machine) => has(machine.client));
    this.archive = any((client) => client.archive)
      ? { list: () => this.archivedTasks() }
      : undefined;
    this.ports = any((client) => client.ports) ? { list: () => this.servicePorts() } : undefined;
    this.devices = any((client) => client.devices)
      ? {
          list: () => this.deviceList(),
          invite: () => this.inviteDevice(),
          decide: (id, decision) => this.decideOn(id, decision),
        }
      : undefined;
    this.unsubscribers = machines.map((machine) =>
      machine.client.subscribe((frame) => this.relay(machine.name, frame)),
    );
  }

  subscribe(listener: SyncListener): Unsubscribe {
    return this.sink.subscribe(listener);
  }

  connect(): void {
    for (const machine of this.machines) {
      machine.client.connect();
    }
  }

  close(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    for (const machine of this.machines) {
      machine.client.close();
    }
  }

  focusTask(taskId: string | null): void {
    if (this.focused) {
      this.machineOf(this.focused).client.focusTask(null);
    }
    this.focused = taskId;
    if (taskId) {
      const { machine, id } = this.split(taskId);
      machine.client.focusTask(id);
    }
  }

  listProjects(): Promise<Project[]> {
    return this.gather(async (machine) => {
      const projects = await machine.client.listProjects();

      return projects.map((project) => ({
        ...project,
        id: scoped(project.id, machine.name),
        name: this.machines.length > 1 ? `${project.name} (${machine.name})` : project.name,
      }));
    });
  }

  listTasks(): Promise<TaskSummary[]> {
    return this.gather(async (machine) => {
      const tasks = await machine.client.listTasks();

      return tasks.map((task) => this.scopeTask(task, machine.name));
    });
  }

  listProviders(): Promise<AgentProvider[]> {
    return this.gather(async (machine) => {
      const providers = await machine.client.listProviders();

      return providers.map((provider) => ({
        id: scoped(provider.id, machine.name),
        label: `${provider.label} @ ${machine.name}`,
      }));
    });
  }

  async listModels(providerId: string): Promise<ModelOption[]> {
    const { machine, id } = this.split(providerId);

    return await machine.client.listModels(id);
  }

  async createTask(input: CreateTaskInput): Promise<TaskSummary> {
    const project = this.split(input.projectId);
    const provider = this.split(input.providerId);
    if (project.machine !== provider.machine) {
      throw new DovoError(
        `${project.machine.name} cannot run an agent from ${provider.machine.name}; pick one on ${project.machine.name}`,
      );
    }
    const task = await project.machine.client.createTask({
      ...input,
      projectId: project.id,
      providerId: provider.id,
    });

    return this.scopeTask(task, project.machine.name);
  }

  async getTaskHistory(taskId: string): Promise<TaskHistory> {
    const { machine, id } = this.split(taskId);

    return await machine.client.getTaskHistory(id);
  }

  async sendMessage(taskId: string, text: string): Promise<void> {
    const { machine, id } = this.split(taskId);

    return await machine.client.sendMessage(id, text);
  }

  async stopTask(taskId: string): Promise<void> {
    const { machine, id } = this.split(taskId);

    return await machine.client.stopTask(id);
  }

  async setTaskArchived(taskId: string, archived: boolean): Promise<void> {
    const { machine, id } = this.split(taskId);

    return await machine.client.setTaskArchived(id, archived);
  }

  async deleteTask(taskId: string): Promise<void> {
    const { machine, id } = this.split(taskId);

    return await machine.client.deleteTask(id);
  }

  async answerItem(taskId: string, itemId: string, answer: string): Promise<void> {
    const { machine, id } = this.split(taskId);

    return await machine.client.answerItem(id, itemId, answer);
  }

  // --- optional abilities: present when any machine has them -------------------

  private archivedTasks(): Promise<TaskSummary[]> {
    return this.gather(async (machine) => {
      const tasks = (await machine.client.archive?.list()) ?? [];

      return tasks.map((task) => this.scopeTask(task, machine.name));
    });
  }

  private servicePorts(): Promise<ServicePort[]> {
    return this.gather(async (machine) => {
      const ports = (await machine.client.ports?.list()) ?? [];

      return ports.map((port) => ({ ...port, projectId: scoped(port.projectId, machine.name) }));
    });
  }

  private deviceList(): Promise<Device[]> {
    return this.gather(async (machine) => {
      const devices = (await machine.client.devices?.list()) ?? [];

      return devices.map((device) => ({
        ...device,
        id: scoped(device.id, machine.name),
        name: this.machines.length > 1 ? `${device.name} (${machine.name})` : device.name,
      }));
    });
  }

  /** Invites go to the first machine that manages devices: the one this terminal is attached to. */
  private async inviteDevice(): Promise<Invite> {
    const directory = this.machines.find((machine) => machine.client.devices)?.client.devices;
    if (!directory) {
      throw new UnsupportedError("no machine here can manage devices");
    }

    return await directory.invite();
  }

  private async decideOn(deviceId: string, decision: DeviceDecision): Promise<void> {
    const { machine, id } = this.split(deviceId);
    if (!machine.client.devices) {
      throw new UnsupportedError(`${machine.name} cannot manage devices`);
    }

    return await machine.client.devices.decide(id, decision);
  }

  /** Ask every machine; one that is down contributes nothing instead of failing the rest. */
  private async gather<T>(ask: (machine: Machine) => Promise<T[]>): Promise<T[]> {
    const settled = await Promise.allSettled(this.machines.map(ask));
    const answered = settled.filter((result) => result.status === "fulfilled");
    if (answered.length === 0) {
      const failed = settled.find((result) => result.status === "rejected");
      throw failed?.reason instanceof Error ? failed.reason : new DovoError("no machine answered");
    }

    return answered.flatMap((result) => result.value);
  }

  private scopeTask(task: TaskSummary, machine: string): TaskSummary {
    return {
      ...task,
      id: scoped(task.id, machine),
      projectId: scoped(task.projectId, machine),
    };
  }

  private split(scopedId: string): { machine: Machine; id: string } {
    const at = scopedId.lastIndexOf(SEPARATOR);
    const machine = this.machines.find((candidate) => candidate.name === scopedId.slice(at + 1));
    if (at < 0 || !machine) {
      throw new DovoError(`unknown machine in id ${scopedId}`);
    }

    return { machine, id: scopedId.slice(0, at) };
  }

  private machineOf(scopedId: string): Machine {
    return this.split(scopedId).machine;
  }

  /** Re-tag a machine's frame so its ids and connection state fit the merged view. */
  private relay(machine: string, frame: SyncFrame): void {
    if (frame.type === "connection") {
      this.phases.set(machine, frame.state);
      this.sink.publish({ type: "connection", state: this.mergedPhase() });

      return;
    }
    if (frame.type === "event") {
      const event = { ...frame.event, taskId: scoped(frame.event.taskId, machine) };
      this.sink.publish({ type: "event", event });

      return;
    }
    this.sink.publish(frame);
  }

  /** The merged connection: as good as the best machine, so one outage is not "offline". */
  private mergedPhase(): ConnectionPhase {
    const phases = [...this.phases.values()];
    const best = phases.sort((a, b) => PHASE_RANK[a] - PHASE_RANK[b])[0];

    return best ?? "offline";
  }
}

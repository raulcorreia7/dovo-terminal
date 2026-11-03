import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { assertSafeHost, freePort, sshArgs, Tunnel, type TunnelState } from "../src/tunnel.ts";

const SPEC = { host: "me@build-box", remotePort: 8787, localPort: 18_787 };
const NOT_USABLE = /not a usable ssh host/u;

describe("assertSafeHost", () => {
  it("accepts user@host, aliases and IPv6 brackets", () => {
    for (const host of ["me@box", "box", "box.example.com", "me@[::1]", "a_b-c.d"]) {
      assert.doesNotThrow(() => assertSafeHost(host), host);
    }
  });

  it("rejects anything ssh could read as an option or a second word", () => {
    for (const host of ["-oProxyCommand=x", "-J evil", "", "a b", "a;b", "a\nb", "a$(x)"]) {
      assert.throws(() => assertSafeHost(host), NOT_USABLE, JSON.stringify(host));
    }
  });
});

describe("sshArgs", () => {
  const args = sshArgs(SPEC, "/home/me/.ssh/dovo-cm");

  it("forwards only loopback to loopback", () => {
    assert.ok(args.includes("127.0.0.1:18787:127.0.0.1:8787"));
  });

  it("puts the host after -- so it can never be an option", () => {
    assert.equal(args.at(-2), "--");
    assert.equal(args.at(-1), "me@build-box");
  });

  it("shares one connection and fails loudly when the forward cannot be made", () => {
    assert.ok(args.includes("ControlMaster=auto"));
    assert.ok(args.includes("ControlPath=/home/me/.ssh/dovo-cm/%C"));
    assert.ok(args.includes("ExitOnForwardFailure=yes"));
    assert.ok(args.includes("BatchMode=yes"));
  });
});

class FakeChild extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;

    return true;
  }
}

function harness() {
  const children: FakeChild[] = [];
  let listening = false;
  const tunnel = new Tunnel(SPEC, {
    spawn: () => {
      const child = new FakeChild();
      children.push(child);

      return child as never;
    },
    backoffMs: [5],
    probe: () => Promise.resolve(listening),
  });
  const states: TunnelState[] = [];
  tunnel.onChange((state) => states.push(state));

  const listen = () => {
    listening = true;
  };

  return { tunnel, children, states, listen };
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Tunnel", () => {
  it("is connecting until the forwarded port answers, then up", async () => {
    const { tunnel, listen } = harness();
    tunnel.start();
    assert.equal(tunnel.state, "connecting");

    listen();
    await later(450);

    assert.equal(tunnel.state, "up");
    tunnel.stop();
  });

  it("restarts after ssh exits, and goes down in between", async () => {
    const { tunnel, children, states, listen } = harness();
    tunnel.start();
    listen();
    await later(450);

    children[0]?.emit("exit");
    assert.equal(tunnel.state, "down");
    await later(30);

    assert.equal(children.length, 2);
    assert.ok(states.includes("down"));
    tunnel.stop();
  });

  it("stops for good: kills ssh and does not restart", async () => {
    const { tunnel, children } = harness();
    tunnel.start();

    tunnel.stop();
    children[0]?.emit("exit");
    await later(30);

    assert.equal(children[0]?.killed, true);
    assert.equal(children.length, 1);
    assert.equal(tunnel.state, "stopped");
  });

  it("refuses an unsafe host before spawning anything", () => {
    assert.throws(() => new Tunnel({ ...SPEC, host: "-oProxyCommand=x" }), NOT_USABLE);
  });
});

describe("freePort", () => {
  it("returns a usable local port", async () => {
    const port = await freePort();

    assert.ok(port > 1023 && port < 65_536);
  });
});

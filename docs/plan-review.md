# Adversarial review of the plan

**Artifact:** [plan.md](plan.md) (first draft) · **Method:** two isolated reviewers,
a breaker and a verifier, each given the same neutral packet and no view of the
other's report; claims were then checked against the repository. Agreement
between reviewers was not treated as evidence.

**Criteria:** C1 implementation-ready · C2 truthful about what exists · C3 secure ·
C4 staged and reversible · C5 failure handling · C6 simplicity and reuse ·
C7 click-through feasible as stated.

**Verdict:** not ready as first drafted. Both reviewers found findings. The
revised plan addresses every confirmed item.

## Confirmed

| #   | Finding                                                                                                                                                      | Criterion | Evidence                                                                | Where fixed                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | The plan did not say what is built, so S3/S4 read as greenfield                                                                                              | C2, C4    | `packages/a2a`, `federated.ts`, `--a2a` exist                           | "What exists today" table                                 |
| 2   | Restart or redelivery creates a second Dovo task: the A2A-to-Dovo map is an in-memory `Map`, and no message id is deduplicated                               | C5        | `executor.ts`: `private readonly runs = new Map`; no `messageId` lookup | S4 (persist before create), S5 tests                      |
| 3   | "Token per worker, in the 0600 config; rotate with `dovo token`" was false: the token is random per start and printed; `dovo token` attaches a runtime token | C2, C3    | `cli.ts`, `server.ts`                                                   | Security table; S4 rotation command                       |
| 4   | Config mode was only applied at file creation                                                                                                                | C3        | `writeFileSync` `mode` option                                           | **Fixed in code**, with a test                            |
| 5   | An unreadable config was replaced by defaults on the next save, losing profiles and tokens                                                                   | C4, C5    | `loadConfig` caught every error                                         | **Fixed in code** (`.bak`), with a test                   |
| 6   | One bearer token can run any project and provider via message metadata                                                                                       | C3        | `executor.ts`: metadata read without an allowlist                       | S4 allowlist                                              |
| 7   | The card declares no security scheme and advertises the listen address, with no public base URL setting                                                      | C3        | `server.ts`: `securitySchemes: {}`, `http://${hostname}`                | S4                                                        |
| 8   | "Orchestrator ignores a different host in the card" had no mechanism                                                                                         | C3        | plan text                                                               | S3: replace the URL; hostile-card test                    |
| 9   | Click-through is a forwarding surface: ownership by working folder is spoofable and ports can be reused                                                      | C3        | design                                                                  | S2b: re-validate pid and start time; remote loopback only |
| 10  | S2b needs `ssh -O forward`, which needs a control socket the tunnel step did not provide                                                                     | C1        | S2 specified plain `-N -L`                                              | S2: ControlMaster                                         |
| 11  | `/ports` was unreachable over the tunnel and unauthenticated in the design; orchestrated tasks had no path to ports                                          | C1, C7    | design                                                                  | S2b owner, token and S3 dependency                        |
| 12  | "Open in a browser" is wrong when the terminal itself runs over ssh or headless                                                                              | C7        | design                                                                  | S2b: print the URL                                        |
| 13  | Dependencies were inconsistent: S0 "blocks S1–S6" while S2 and S6 said none; S3 ignored O1; S0 had no fallback or redaction                                  | C1        | plan text                                                               | Step headers; S0                                          |
| 14  | O2 (who approves) was open while the security table already asserted "never auto-answers"                                                                    | C3        | plan text                                                               | Decision D6                                               |
| 15  | Orchestrator safety was untested: retry with side effects, loops, budget, two writers on one repo, cancellation                                              | C5        | plan text                                                               | S5 validation, D7                                         |
| 16  | `cancelTask` reports `contextId: ""` and swallows a failed stop                                                                                              | C5        | `executor.ts`                                                           | S4                                                        |
| 17  | `prune` had undefined remote and soft-delete semantics                                                                                                       | C5        | plan text                                                               | S6                                                        |
| 18  | `--deep` spends model budget and must not be the timer default                                                                                               | C6        | plan text                                                               | S1, S7                                                    |

## Disputed

- **Severity of the card-URL risk (item 8).** The SDK's real behaviour was not
  exercised by either reviewer or by this review; the mitigation is kept as a
  required test in S3 rather than assumed.
- **Whether the SDK's SQLite store is production-ready.** It exists in
  `@a2a-js/sdk` 1.3.0, but its native driver and support level were not
  checked; S4 says to choose the driver deliberately.

## Rejected

- **"Federation ids containing `@` break routing."** `split` uses `lastIndexOf`
  and machine names may not contain `@`, so an id containing `@` still resolves.
- **"The ADR's measurement may not be recorded."** The measured table is in the
  ADR.
- **"Any follow-up message answers an approval."** As stated, false: a follow-up
  is sent with `sendMessage`, which is chat text. The consequence is the reverse:
  an `input-required` task cannot be answered over A2A at all today. That is now
  a known defect and the reason for decision D6 and the typed approval message in S3.

## Residual uncertainty

- The A2A SDK's handling of message ids and of the card's URL.
- Whether the Dovo runtime exposes ports (A3) and what "available" means (A2).
- Linux `/proc` behaviour on the real target hosts.
- Everything about real multi-machine operation: none of it has been run.

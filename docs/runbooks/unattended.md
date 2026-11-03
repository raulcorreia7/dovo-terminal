# Runbook: run workers and checks unattended

Run the worker (or orchestrator) as a service and a health check on a timer. The
terminal command line is the same on macOS and Linux; only the service manager
differs.

## Linux (systemd, per user)

`~/.config/systemd/user/dovo-worker.service`:

```ini
[Unit]
Description=Dovo A2A worker
After=network-online.target

[Service]
ExecStart=/usr/bin/env dovo serve --a2a 8791
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now dovo-worker
loginctl enable-linger "$USER"        # keep it running when you are logged out
```

A check every ten minutes, `dovo-doctor.service` and `dovo-doctor.timer`:

```ini
# dovo-doctor.service
[Service]
Type=oneshot
ExecStart=/usr/bin/env dovo doctor --all
```

```ini
# dovo-doctor.timer
[Timer]
OnCalendar=*:0/10
Persistent=true
[Install]
WantedBy=timers.target
```

## macOS (launchd)

`~/Library/LaunchAgents/dev.dovo.worker.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.dovo.worker</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/env</string><string>dovo</string><string>serve</string><string>--a2a</string><string>8791</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

```sh
launchctl load ~/Library/LaunchAgents/dev.dovo.worker.plist
```

For the check, add `StartInterval` (seconds, e.g. `600`) to a second plist whose
`ProgramArguments` are `dovo doctor --all`.

## Telling you when something fails

`dovo doctor` exits non-zero when a check fails. Set `teamsWebhook` in the config
to get a message when a task needs you or finishes. A failing doctor can post the
same way from a small wrapper script of your own: `dovo doctor --all || curl …`.

Do not give `--deep`-style checks (anything that sends a prompt to a model) to a
timer; they spend money.

## Notes

- The service needs the tools your PATH has in your shell, so use the full path to
  `dovo` if the service manager's PATH is minimal (`which dovo`).
- The worker's token lives in the config file (mode 0600). Do not put it in a unit
  file.
- None of these units has been run on a clean machine yet; treat the first run as
  the test.

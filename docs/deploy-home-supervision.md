# Rolling the supervised home images onto Edison's home

Branch `fix/home-image-supervision`. Built on toon2 under new tags only: `charter-home:supervise-1106` and
`charter-hermes:supervise-1106` (BASE = the new home tag). `latest` is untouched until step 2.

What reaches a box from where:

- The log cap (`/app/logcap.sh`, started by `/app/home.sh`) is image-owned: it reaches Edison's box at the
  re-create, whatever `~/.charter/boot.sh` says.
- The payer supervisor, the validated pidfiles and lock, and `boot.sh stop` live in `/app/boot-default.sh`.
  The image copies it to `~/.charter/boot.sh` only when that file is absent, so Edison's box keeps its
  11-05 copy unless step 3 replaces it.
- The refused-connection retry in `charter renew` is in `/opt/charter`: image-owned, reaches the box at the
  re-create.

No lapse window is needed. A home whose container is gone is re-created by `charter-host` at its next start
(`reconcile`), from the current `charter-hermes` tag, on the same disk and onion, while its paid time has not
run out (how Edison came back after the 11-06 VM grow). The running host has no exit watch on homes, so a
stopped home is not closed while the host restarts. Downtime is the re-create plus the boot, about a minute;
the paid time keeps running and renew in the new box re-attaches and pays when due.

## 0. Checks (read only)

```bash
ssh air
~/.local/lima/bin/limactl shell toon2
```

- `df -h /` shows well over 3 GiB free (the host's floor).
- No lease is `booting` or `awaiting_first_tick` (a host restart closes those `host_restart`):
  `jq '[.[] | select(.state=="booting" or .state=="awaiting_first_tick")] | length' ~/.local/share/charter/leases.json` is `0`.
- Edison is paid ahead: `docker exec <edison container> cat /charter/paid-through` is at least 30 min out
  (renew pays at half the interval, so it normally is). Pick a moment right after a tick lands
  (`renew.log` says `paid tick N`), so no payment is in flight when the container stops.

## 1. Keep the old images by name

```bash
docker tag charter-hermes:latest charter-hermes:pre-1106
docker tag charter-home:latest charter-home:pre-1106
```

## 2. Point latest at the new build

```bash
docker tag charter-home:supervise-1106 charter-home:latest
docker tag charter-hermes:supervise-1106 charter-hermes:latest
```

This changes nothing that is running. Every home picks it up at its next re-create.

## 3. Give Edison's box the new default boot (atomically)

Edison's container is `charter-09fb199ac8ba540344c3c4ec73b53e41` as of 11-06; confirm with `docker ps`.

```bash
c=charter-09fb199ac8ba540344c3c4ec73b53e41
docker exec "$c" cat /app/boot-default.sh > /tmp/boot-old-default.sh
docker exec "$c" cat /home/tenant/.charter/boot.sh > /tmp/edison-boot.sh
diff /tmp/boot-old-default.sh /tmp/edison-boot.sh && echo "Edison runs the stock 11-05 boot"
```

If the diff is empty (Edison's own settings live in `~/.charter/payer.env`, which the new boot reads the same
way), install the new one with a rename, never an edit in place: a running `sh` reads its script as it goes.

```bash
docker run --rm --entrypoint cat charter-hermes:supervise-1106 /app/boot-default.sh > /tmp/boot-new.sh
docker exec -i "$c" sh -c 'cp ~/.charter/boot.sh ~/.charter/boot.sh.pre-1106 && cat > ~/.charter/boot.sh.new && chmod 700 ~/.charter/boot.sh.new && mv -f ~/.charter/boot.sh.new ~/.charter/boot.sh' < /tmp/boot-new.sh
docker exec "$c" sh -c 'ls -l ~/.charter/boot.sh*'
```

If the diff is not empty, stop here and merge Edison's changes into the new file first.

## 4. Re-create the box from the new image

```bash
docker stop "$c"
systemctl --user restart charter-host
journalctl --user -u charter-host -n 30 --no-pager
```

The host log names the re-create. `docker ps` shows a new container for the same lease id on
`charter-hermes` (`docker inspect -f '{{.Image}}' <name>` is the new image id).

## 5. Verify

```bash
c=$(docker ps --filter name=charter-09fb199a --format '{{.Names}}')
docker exec "$c" sh -c 'grep "^boot:" ~/.charter/boot.log | tail -6; ps -eo pid,args | grep -E "[l]ogcap|[c]li.js|[h]ermes gateway"'
```

- `boot: took the lock`, `boot: payer started on 127.0.0.1:3510 (pid N)`, `boot: payer address 0x…`,
  `boot: renew started`, `boot: gateway started`; one `cli.js payer`, one `hermes gateway run`, one `logcap.sh`.
- Drew sends Edison a Telegram message and gets an answer.
- The next tick lands in `~/.charter/renew.log` and `/charter/paid-through` moves on.

## Rollback

```bash
docker tag charter-hermes:pre-1106 charter-hermes:latest
docker tag charter-home:pre-1106 charter-home:latest
docker exec "$c" sh -c 'mv -f ~/.charter/boot.sh.pre-1106 ~/.charter/boot.sh'
docker stop "$c"; systemctl --user restart charter-host
```

## Not covered

- A tenant box that already has its own `~/.charter/boot.sh` (none but Edison's today) keeps it: only the log
  cap and the renew retry reach it. A new box gets the new default.
- A payer that is alive but hung (not answering `/health`) is waited for, not killed: one writer per channel
  store comes first. Only an exited payer is restarted.
- The hermes-toon plugins talk to the payer with their own client; a call made while the payer restarts
  fails once, as before.

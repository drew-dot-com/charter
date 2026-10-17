# Charter: a real compute job (Python)

Status: Claude's design, written 2026-10-17 after Drew asked to skip the questions. Every choice here is Claude's call.

## Why

v1 can run only the fetch job, which is a paid proxy, not compute ("I thought this was a compute network?"). A renter
must be able to bring their own work. The job that does that also sets the safety model for every host, so it is
chosen to be the one a home host can carry with the least risk.

## The job

`charter-job-python`: the renter sends a Python 3.12 script (UTF-8, at most 8 KiB). The host runs it to completion
and returns its stdout, stderr, exit code and wall time. NumPy is in the image so real numeric work runs.

- Input: job arg `SCRIPT` only. Data goes inside the script. 8 KiB keeps the open packet well under ILP's 32 KiB
  data limit after sealing.
- Output: `/out/result.json` =
  `{ kind: "python", exitCode, signal, timedOut, seconds, stdout, stderr, stdoutTruncated, stderrTruncated }`.
  stdout keeps the first 256 KiB, stderr the first 64 KiB.
- A script that fails is still a finished job: the wrapper exits 0 and the result says how the script ended. Only a
  wrapper failure (an empty or oversize script) exits 2 with `/out/error.txt`, as the fetch job does.
- Wall cap 600 s inside the wrapper; payment stopping ends it sooner, as for every job.

## Safety model (the reason for the pick)

Arbitrary code is the hardest case, so it sets the bar:

1. **No network at all** (`--network none`, no proxy). The script cannot attack, spam, scrape or fetch anything for
   anyone, so the host's IP and reputation are never at stake and hidden egress does not matter for this job.
2. The v1 container limits stay: 1 CPU, 1 GiB, no swap, 256 pids, read-only root, no capabilities,
   `no-new-privileges`, unprivileged user.
3. New for this image: `/tmp` is a 64 MiB tmpfs, and every file the job writes is capped at 8 MiB (`ulimit fsize`),
   which bounds what the script can put in the host's `/out` dir.
4. The script runs as a child of the wrapper with a clean environment (no job args, nothing from the host) and in its
   own process group, which the wrapper kills on exit or timeout.
5. **Optional stronger kernel boundary:** `CHARTER_RUNTIME=runsc` runs every job under gVisor. Recommended for any
   host that takes code from strangers. On `toon2` a container escape would land in a VM that holds the node's
   wallet, so installing gVisor there before opening Python leases to anyone but Drew is the deploy step to decide.

6. The wrapper also caps the script itself below the container's limits (128 processes, 768 MiB address space, one
   BLAS thread), so a runaway script gets a clean error and the renter still gets a result.

Residual risk, accepted: a script can burn its paid CPU (that is the product) and can write up to the fsize cap per
file into `/out` while it runs. Under gVisor, a raw `os.fork` bomb (Docker's pids limit counts the sandbox's own host
threads there) or a SIGKILL to PID 1 ends the sandbox with no output: the renter loses their own lease, the host
loses nothing.

Deployed 2026-10-17 on `toon2` with gVisor `release-20261012.0` (systrap, no KVM). Both images were probed under
`runsc` with the runner's exact flags; the fetch job still exits through Anyone.

## What changes

- **Job image** `jobs/python/`: `python:3.12-slim` + pinned NumPy, wrapper `run.py`.
- **Runner**: a profile per image (allowed args, arg byte cap, network mode, extra limits). Fetch keeps its v1
  behaviour exactly. Optional `--runtime` from `CHARTER_RUNTIME`.
- **Door**: `POST /v1/leases` takes either `{ offerId, urls }` or `{ offerId, python: { script } }`; offers carrying
  either image are listed.
- **Web**: the rent form picks "Fetch pages" or "Run Python" (with a NumPy example); the lease page shows exit code,
  time, stdout and stderr.
- **CLI**: `charter rent --python <file>`.
- **Not in this change**: Edison's `charter_rent` tool (hermes-toon repo), deploy to `toon2` and the door (each needs
  Drew's go), input files, GPUs, other languages.

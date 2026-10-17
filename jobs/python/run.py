# Charter python job. Input: env SCRIPT (Python 3 source, UTF-8, at most 8 KiB).
# Output: /out/result.json { kind, exitCode, signal, timedOut, seconds, stdout, stderr,
# stdoutTruncated, stderrTruncated }, exit 0, whatever the script did.
# On a bad input: /out/error.txt and exit 2.
# The container has no network; this wrapper only bounds the script and reports on it.
import json
import os
import resource
import signal
import subprocess
import sys
import tempfile
import threading
import time

MAX_SCRIPT_BYTES = 8 * 1024
MAX_STDOUT_BYTES = 256 * 1024
MAX_STDERR_BYTES = 64 * 1024
WALL_SECONDS = 600
READ_CHUNK = 64 * 1024
# Below the container's own limits (1 GiB, 256 pids), so a runaway script fails inside itself and this
# wrapper still reports. Under gVisor, hitting the container limit takes the whole sandbox down with it.
SCRIPT_MAX_PROCS = 128
SCRIPT_MAX_ADDRESS_BYTES = 768 * 1024 * 1024

OUT_DIR = os.environ.get('CHARTER_OUT', '/out')


def fail(message):
    with open(os.path.join(OUT_DIR, 'error.txt'), 'w', encoding='utf-8') as f:
        f.write(str(message)[:4096])
    sys.exit(2)


def drain(stream, cap, sink):
    """Keep the first `cap` bytes, read and drop the rest so the script never blocks on a full pipe."""
    kept = bytearray()
    truncated = False
    while True:
        chunk = stream.read(READ_CHUNK)
        if not chunk:
            break
        room = cap - len(kept)
        if room > 0:
            kept += chunk[:room]
        if len(chunk) > room:
            truncated = True
    sink['bytes'] = bytes(kept)
    sink['truncated'] = truncated


def limit_script():
    """Runs in the script's process before it starts. Best effort: a platform without a limit keeps the container's."""
    procs = int(os.environ.get('CHARTER_SCRIPT_MAX_PROCS', SCRIPT_MAX_PROCS))
    for name, value in (('RLIMIT_NPROC', procs), ('RLIMIT_AS', SCRIPT_MAX_ADDRESS_BYTES)):
        which = getattr(resource, name, None)
        if which is None:
            continue
        try:
            resource.setrlimit(which, (value, value))
        except (ValueError, OSError):
            pass


def main():
    src = os.environ.get('SCRIPT', '')
    raw = src.encode('utf-8', errors='surrogatepass')
    if not src.strip():
        fail('SCRIPT is empty')
    if len(raw) > MAX_SCRIPT_BYTES:
        fail(f'SCRIPT is {len(raw)} bytes, max {MAX_SCRIPT_BYTES}')
    wall = int(os.environ.get('CHARTER_WALL_SECONDS', WALL_SECONDS))

    work = tempfile.mkdtemp(prefix='job-')
    path = os.path.join(work, 'job.py')
    with open(path, 'wb') as f:
        f.write(raw)

    # Nothing from the wrapper's env reaches the script: not SCRIPT, not anything the host set.
    env = {
        'PATH': '/usr/local/bin:/usr/bin:/bin',
        'HOME': work,
        'LANG': 'C.UTF-8',
        'PYTHONDONTWRITEBYTECODE': '1',
        'PYTHONUNBUFFERED': '1',
        # One CPU: one BLAS thread, which also keeps NumPy's address space inside the cap.
        'OPENBLAS_NUM_THREADS': '1',
        'OMP_NUM_THREADS': '1',
    }
    started = time.monotonic()
    proc = subprocess.Popen(
        [sys.executable, '-I', path],
        cwd=work,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        # Its own process group, so every process it starts dies with it.
        start_new_session=True,
        preexec_fn=limit_script,
    )
    out, err = {}, {}
    readers = [
        threading.Thread(target=drain, args=(proc.stdout, MAX_STDOUT_BYTES, out), daemon=True),
        threading.Thread(target=drain, args=(proc.stderr, MAX_STDERR_BYTES, err), daemon=True),
    ]
    for t in readers:
        t.start()

    timed_out = False
    try:
        proc.wait(timeout=wall)
    except subprocess.TimeoutExpired:
        timed_out = True
    seconds = time.monotonic() - started
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    proc.wait()
    for t in readers:
        t.join(timeout=5)

    code = proc.returncode
    result = {
        'kind': 'python',
        'exitCode': code if code >= 0 else None,
        'signal': signal.Signals(-code).name if code < 0 else None,
        'timedOut': timed_out,
        'seconds': round(seconds, 3),
        'stdout': out.get('bytes', b'').decode('utf-8', errors='replace'),
        'stderr': err.get('bytes', b'').decode('utf-8', errors='replace'),
        'stdoutTruncated': out.get('truncated', False),
        'stderrTruncated': err.get('truncated', False),
    }
    tmp = os.path.join(OUT_DIR, 'result.json.tmp')
    # The script shares this dir and may have left something here; never follow it.
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    with open(tmp, 'x', encoding='utf-8') as f:
        json.dump(result, f)
    os.replace(tmp, os.path.join(OUT_DIR, 'result.json'))


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 - any wrapper failure is reported the same way
        fail(f'wrapper: {e!r}')

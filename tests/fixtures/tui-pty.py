#!/usr/bin/env python3
"""Minimal reusable PTY driver for the gated OpenCode v2 TUI ABI test (Spec T18).

Launches a command under a fresh controlling PTY, feeds a scheduled sequence of
keystroke/mouse byte strings, and dumps the raw terminal stream. It also writes
a reconstructed final screen and one screen snapshot per labelled step, so the
caller can assert on what the real TUI actually rendered (not on source text).

It owns only its own process group and temp files. It never reads a user
profile; the caller passes an isolated environment through ``os.environ``.

Usage:
  tui-pty.py --out RAW --schedule SCHED.json [--cols N] [--rows N]
             [--timeout SECS] [--cwd DIR] -- CMD [ARGS...]

SCHED.json: [{"at": seconds, "send": "text", "label": "optional"}, ...]
"""

import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
import fcntl


def parse_argv(argv):
    opts = {"cols": 120, "rows": 40, "timeout": 20.0, "cwd": None}
    i = 0
    command = []
    while i < len(argv):
        arg = argv[i]
        if arg == "--":
            command = argv[i + 1 :]
            break
        if arg == "--out":
            opts["out"] = argv[i + 1]
            i += 2
        elif arg == "--schedule":
            opts["schedule"] = argv[i + 1]
            i += 2
        elif arg == "--cols":
            opts["cols"] = int(argv[i + 1])
            i += 2
        elif arg == "--rows":
            opts["rows"] = int(argv[i + 1])
            i += 2
        elif arg == "--timeout":
            opts["timeout"] = float(argv[i + 1])
            i += 2
        elif arg == "--cwd":
            opts["cwd"] = argv[i + 1]
            i += 2
        else:
            raise SystemExit(f"unknown argument: {arg}")
    if not opts.get("out") or not opts.get("schedule") or not command:
        raise SystemExit(
            "usage: tui-pty.py --out RAW --schedule JSON [--cols N] [--rows N] -- CMD..."
        )
    return opts, command


def render(raw, rows, cols):
    """Reconstruct the final visible grid from a captured terminal stream."""
    import re

    grid = [[" "] * cols for _ in range(rows)]
    r = c = 0
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch == "\x1b":
            m = re.match(r"\x1b\[([0-9;?]*)([A-Za-z])", raw[i:])
            if m:
                params, cmd = m.group(1), m.group(2)
                nums = [
                    int(p) for p in params.replace("?", "").split(";") if p.isdigit()
                ]
                if cmd in "Hf":
                    r = (nums[0] - 1) if len(nums) > 0 else 0
                    c = (nums[1] - 1) if len(nums) > 1 else 0
                elif cmd == "A":
                    r = max(0, r - (nums[0] if nums else 1))
                elif cmd == "B":
                    r = min(rows - 1, r + (nums[0] if nums else 1))
                elif cmd == "C":
                    c = min(cols - 1, c + (nums[0] if nums else 1))
                elif cmd == "D":
                    c = max(0, c - (nums[0] if nums else 1))
                elif cmd == "G":
                    c = (nums[0] - 1) if nums else 0
                elif cmd == "d":
                    r = (nums[0] - 1) if nums else 0
                elif cmd == "J":
                    mode = nums[0] if nums else 0
                    if mode in (2, 3):
                        grid = [[" "] * cols for _ in range(rows)]
                    elif mode == 0:
                        for cc in range(c, cols):
                            grid[r][cc] = " "
                        for rr in range(r + 1, rows):
                            grid[rr] = [" "] * cols
                elif cmd == "K":
                    mode = nums[0] if nums else 0
                    if mode == 0:
                        for cc in range(c, cols):
                            grid[r][cc] = " "
                    elif mode == 1:
                        for cc in range(0, c + 1):
                            grid[r][cc] = " "
                    elif mode == 2:
                        grid[r] = [" "] * cols
                i += m.end()
                continue
            m = re.match(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", raw[i:])
            if m:
                i += m.end()
                continue
            m = re.match(r"\x1b[=>()][0-9A-Za-z]?", raw[i:])
            if m:
                i += m.end()
                continue
            i += 1
            continue
        if ch == "\r":
            c = 0
        elif ch == "\n":
            r = min(rows - 1, r + 1)
        elif ch == "\b":
            c = max(0, c - 1)
        elif ch == "\t":
            c = min(cols - 1, (c // 8 + 1) * 8)
        elif ch == "\x07":
            pass
        elif ord(ch) >= 32:
            if 0 <= r < rows and 0 <= c < cols:
                grid[r][c] = ch
            c += 1
        i += 1
    return "\n".join("".join(row).rstrip() for row in grid).rstrip("\n")


def locate(screen, text):
    """Return the (row, col) 0-indexed start of `text` in a rendered screen."""
    for row_index, line in enumerate(screen.split("\n")):
        col = line.find(text)
        if col >= 0:
            return row_index, col
    return None


def sgr_click(x, y, button=0):
    """SGR mouse press+release at 1-indexed (x, y); button 0 left, 2 right."""
    return f"\x1b[<{button};{x};{y}M\x1b[<{button};{x};{y}m".encode("utf-8")


def read_pty_once(fd, raw, timeout=0.2):
    """Extiende raw con una lectura del PTY.

    Devuelve "data" si llegaron bytes, "idle" si no había nada listo y "closed"
    si el PTY terminó o falló. Los tres bucles de la sesión comparten esta única
    lectura para no duplicar select/read/EOF/OSError.
    """
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready:
        return "idle"
    try:
        data = os.read(fd, 65536)
    except OSError:
        return "closed"
    if not data:
        return "closed"
    raw.extend(data)
    return "data"


def main():
    opts, command = parse_argv(sys.argv[1:])
    out = opts["out"]
    schedule = json.load(open(opts["schedule"]))
    schedule = sorted(
        ({"at": float(e["at"]), "label": e.get("label"), "raw": e} for e in schedule),
        key=lambda e: e["at"],
    )

    # Una terminación debe pasar por el finally (flush + stop del grupo hijo),
    # no morir sin limpiar al TUI.
    def _on_sigterm(signum, frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, _on_sigterm)

    pid, fd = pty.fork()
    if pid == 0:
        if opts["cwd"]:
            try:
                os.chdir(opts["cwd"])
            except OSError:
                pass
        os.execvpe(command[0], command, os.environ)
        os._exit(127)

    # El TUI es líder de sesión propio (pty.fork hace setsid): registrarlo permite
    # al llamador detener su grupo aunque este proceso sea SIGKILL.
    with open(out + ".tui.pid", "w") as handle:
        handle.write(str(pid))

    fcntl.ioctl(
        fd, termios.TIOCSWINSZ, struct.pack("HHHH", opts["rows"], opts["cols"], 0, 0)
    )
    os.set_blocking(fd, False)

    raw = bytearray()
    screens = {}
    marks = []
    start = time.time()
    deadline = start + opts["timeout"]
    pending = list(schedule)

    def snapshot(label, length):
        screens[label] = render(
            bytes(raw[:length]).decode("utf-8", "replace"), opts["rows"], opts["cols"]
        )

    try:
        while time.time() < deadline:
            while pending and time.time() - start >= pending[0]["at"]:
                entry = pending.pop(0)
                action = entry["raw"]
                if "waitFor" in action:
                    wait_deadline = min(
                        time.time() + float(action.get("timeout", 20)), deadline
                    )
                    while time.time() < wait_deadline:
                        if action["waitFor"] in render(
                            bytes(raw).decode("utf-8", "replace"),
                            opts["rows"],
                            opts["cols"],
                        ):
                            break
                        if read_pty_once(fd, raw) == "closed":
                            break
                snapshot("before:" + (entry["label"] or str(len(marks))), len(raw))
                marks.append(
                    {
                        "at": round(time.time() - start, 2),
                        "len": len(raw),
                        "label": entry["label"],
                    }
                )
                payload = b""
                if "send" in action:
                    payload = action["send"].encode("utf-8")
                elif "click" in action or "clickAt" in action:
                    current = render(
                        bytes(raw).decode("utf-8", "replace"),
                        opts["rows"],
                        opts["cols"],
                    )
                    if "clickAt" in action:
                        x = int(action["clickAt"]["x"])
                        y = int(action["clickAt"]["y"])
                        button = int(action["clickAt"].get("button", 0))
                    else:
                        spec = action["click"]
                        spot = locate(current, spec["text"])
                        if spot is not None:
                            y = spot[0] + 1
                            x = spot[1] + 1
                        else:
                            x = y = 0
                        button = int(spec.get("button", 0))
                    if x > 0 and y > 0:
                        payload = sgr_click(x, y, button)
                try:
                    os.write(fd, payload)
                except OSError:
                    pass
            if not pending:
                break
            if read_pty_once(fd, raw) == "closed":
                break
        # Let the last scheduled action settle before the final snapshot.
        settle = time.time() + 1.5
        while time.time() < settle:
            if read_pty_once(fd, raw) == "closed":
                break
    finally:
        with open(out, "wb") as handle:
            handle.write(bytes(raw))
        snapshot("final", len(raw))
        with open(out + ".screens.json", "w") as handle:
            json.dump(screens, handle)
        with open(out + ".marks.json", "w") as handle:
            json.dump(marks, handle)
        try:
            pgid = os.getpgid(pid)
        except ProcessLookupError:
            pgid = None
        if pgid is not None:
            try:
                os.killpg(pgid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            reaped = False
            for _ in range(40):
                try:
                    waited, _ = os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    reaped = True
                    break
                if waited == pid:
                    reaped = True
                    break
                time.sleep(0.1)
            if not reaped:
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass
        # El registro se retira solo cuando el grupo del TUI ya no existe; mientras
        # exista, el llamador puede detenerlo aunque este proceso sea SIGKILL.
        try:
            os.remove(out + ".tui.pid")
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass
    print(f"captured {len(raw)} bytes -> {out}")


if __name__ == "__main__":
    main()

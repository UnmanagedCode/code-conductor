# The pty helper: one program under a pseudo-terminal, spoken to over a
# length-prefixed byte protocol on stdin/stdout. Stdlib only, so it runs
# wherever a python3 does; src/systems/ptyHost.ts is its one caller, and it
# owns the frame vocabulary this file mirrors.
#
#   python3 -I ptyHelper.py <cols> <rows> -- <argv...>
#
# The cwd and the environment are the spawn's. A frame is 1 type byte, a u32
# big-endian payload length, then the payload.
#
#   node -> helper   d  bytes for the terminal
#                    r  u16 cols, u16 rows
#   helper -> node   S  the program was exec'd
#                    o  output
#                    x  exit, JSON {code, signal}
#                    e  failure, JSON {code, message}
#
# EOF on stdin is CLOSE: hang the terminal up, then SIGKILL what is left of the
# session's process groups after a grace.

import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

READ_BYTES = 16 * 1024
# How long a hung-up session gets to exit on its SIGHUP (a shell saves its
# history there) before what is left of its groups is SIGKILLed.
CLOSE_GRACE_S = 0.5
# After the program exits, how long the master is read for the output it wrote
# just before exiting while some other process still holds the terminal open.
DRAIN_IDLE_S = 0.05
DRAIN_MAX_S = 1.0


def write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            n = os.write(fd, view)
        except BlockingIOError:
            select.select([], [fd], [])
            continue
        view = view[n:]


def send(kind, payload=b''):
    write_all(1, kind + struct.pack('>I', len(payload)) + payload)


def send_json(kind, obj):
    send(kind, json.dumps(obj).encode())


def set_winsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def exit_info(status):
    if os.WIFSIGNALED(status):
        n = os.WTERMSIG(status)
        try:
            name = signal.Signals(n).name
        except ValueError:
            name = 'SIG%d' % n
        return {'code': None, 'signal': name}
    return {'code': os.WEXITSTATUS(status) if os.WIFEXITED(status) else None, 'signal': None}


def killpg(pgid):
    if pgid is None or pgid <= 0:
        return
    try:
        os.killpg(pgid, signal.SIGKILL)
    except OSError:
        pass


def main():
    if len(sys.argv) < 5 or sys.argv[3] != '--':
        sys.stderr.write('usage: ptyHelper.py <cols> <rows> -- <argv...>\n')
        return 2
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[4:]

    # SIGCHLD wakes the select through a self-pipe. Armed BEFORE the fork, so a
    # program that exits at once still wakes it; both ends are close-on-exec,
    # and the exec resets the handler, so the program inherits neither.
    wake_r, wake_w = os.pipe()
    os.set_blocking(wake_r, False)
    os.set_blocking(wake_w, False)
    signal.set_wakeup_fd(wake_w)
    signal.signal(signal.SIGCHLD, lambda *_: None)

    # Close-on-exec (PEP 446), so EOF on it means the exec succeeded and an
    # errno name on it means it did not.
    status_r, status_w = os.pipe()
    try:
        pid, master = pty.fork()
    except OSError as e:
        send_json(b'e', {'code': 'EPTY', 'message': 'cannot allocate a pseudo-terminal: %s' % e})
        return 1
    if pid == 0:
        os.close(status_r)
        try:
            # Before the exec, so the program never sees a 0x0 terminal.
            set_winsize(0, cols, rows)
            os.execvpe(argv[0], argv, os.environ)
        except OSError as e:
            name = errno.errorcode.get(e.errno, 'EUNKNOWN')
            os.write(status_w, ('%s\n%s: %s' % (name, argv[0], e.strerror)).encode())
        os._exit(127)
    os.close(status_w)
    report = b''
    while True:
        chunk = os.read(status_r, 4096)
        if not chunk:
            break
        report += chunk
    os.close(status_r)
    if report:
        code, _, message = report.decode(errors='replace').partition('\n')
        os.waitpid(pid, 0)
        send_json(b'e', {'code': code, 'message': message})
        return 1
    send(b'S')

    os.set_blocking(master, False)
    master_open = True
    stdin_open = True
    inbuf = b''
    pending = b''
    status = None

    def read_master():
        nonlocal master_open
        try:
            data = os.read(master, READ_BYTES)
        except BlockingIOError:
            return True
        except OSError:
            # EIO: every holder of the terminal's other end has closed it.
            master_open = False
            return False
        if not data:
            master_open = False
            return False
        send(b'o', data)
        return True

    while status is None:
        rl = [wake_r]
        wl = []
        if master_open:
            rl.append(master)
            if pending:
                wl.append(master)
        if stdin_open:
            rl.append(0)
        # The timeout only re-checks waitpid; SIGCHLD is what normally wakes it.
        ready_r, ready_w, _ = select.select(rl, wl, [], 1.0)
        if wake_r in ready_r:
            try:
                while os.read(wake_r, 64):
                    pass
            except BlockingIOError:
                pass
        if master in ready_w and pending:
            try:
                n = os.write(master, pending)
                pending = pending[n:]
            except BlockingIOError:
                pass
            except OSError:
                pending = b''
        if master_open and master in ready_r:
            read_master()
        if stdin_open and 0 in ready_r:
            data = os.read(0, 64 * 1024)
            if not data:
                stdin_open = False
                break
            inbuf += data
            while len(inbuf) >= 5:
                (length,) = struct.unpack('>I', inbuf[1:5])
                if len(inbuf) < 5 + length:
                    break
                kind, payload = inbuf[:1], inbuf[5:5 + length]
                inbuf = inbuf[5 + length:]
                if kind == b'd':
                    pending += payload
                elif kind == b'r' and length == 4:
                    c, r = struct.unpack('>HH', payload)
                    if master_open:
                        try:
                            set_winsize(master, c, r)
                        except OSError:
                            pass
        try:
            wpid, wstatus = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            wpid, wstatus = pid, 0
        if wpid == pid:
            status = wstatus

    if status is not None:
        # The program exited. Read what it wrote just before, until the
        # terminal reports every writer gone (EIO) or goes quiet while a
        # background job still holds it.
        deadline = time.monotonic() + DRAIN_MAX_S
        while master_open and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], DRAIN_IDLE_S)
            if not ready or not read_master():
                break
        send_json(b'x', exit_info(status))
        return 0

    # CLOSE: the owner went away. Closing the master hangs the terminal up,
    # which SIGHUPs the session leader and the foreground group.
    try:
        foreground = os.tcgetpgrp(master)
    except OSError:
        foreground = None
    os.close(master)
    deadline = time.monotonic() + CLOSE_GRACE_S
    while time.monotonic() < deadline:
        try:
            wpid, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            break
        if wpid == pid:
            break
        time.sleep(0.01)
    # The session leader's group is its pid (pty.fork's setsid). A job that
    # left the session survives, as it does when a terminal window closes.
    killpg(pid)
    killpg(foreground)
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())

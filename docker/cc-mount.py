#!/usr/bin/env python3
"""cc-mount — bind-mount one host directory into the running conductor container.

    sudo python3 cc-mount.py [-r] [--container NAME | --pid PID] [--check] HOST-DIR

Mounts HOST-DIR at /workspaces/<basename> in the running code-conductor
container (found automatically via docker label
com.docker.compose.service=conductor) using the new mount API against the
container's PID: detached open_tree -> setns -> move_mount. stdlib-only.

Requires: Linux >= 5.2, root (CAP_SYS_ADMIN in the owning user namespace) on
the host, Python 3.8+. The mount is invisible to `docker inspect .Mounts` and
does not survive a container restart. Full contract, exit codes and the
removal recipe: docker/README.md.
"""

import argparse
import ctypes
import errno
import os
import platform
import stat
import subprocess
import sys

# Kernel syscall numbers by platform.machine().
ARCH_SYSCALLS = {
    "x86_64": {"setns": 308, "open_tree": 428, "move_mount": 429},
    "aarch64": {"setns": 268, "open_tree": 428, "move_mount": 429},
    "riscv64": {"setns": 268, "open_tree": 428, "move_mount": 429},
}

# linux/mount.h, linux/fcntl.h, linux/sched.h
OPEN_TREE_CLONE = 1
OPEN_TREE_CLOEXEC = 0x80000
AT_RECURSIVE = 0x8000
AT_FDCWD = -100
CLONE_NEWNS = 0x00020000
MOVE_MOUNT_F_EMPTY_PATH = 0x00000004
MOVE_MOUNT_T_SYMLINKS = 0x00000010

RESERVED_NAMES = ("projects", "code-conductor")
EX_USAGE, EX_RESOLVE, EX_MOUNT, EX_TARGET = 2, 3, 4, 5
_RD_CLOEXEC = os.O_RDONLY | os.O_CLOEXEC
_PTRACE_HINT = ("; reading another process's %s requires PTRACE_MODE_READ on it"
                " (run with sudo)")

NUMBERS = ARCH_SYSCALLS.get(platform.machine())
_PLATFORM_FAIL = "unsupported platform %s/%s (need linux on %s)" % (
    sys.platform, platform.machine(), ", ".join(sorted(ARCH_SYSCALLS)))
_TRAMPOLINE = None


def fail(code, msg):
    print("cc-mount: %s" % msg, file=sys.stderr)
    sys.exit(code)


def _trampoline():
    """libc's syscall(2): the named wrappers need glibc >= 2.36; this works everywhere."""
    global _TRAMPOLINE
    if _TRAMPOLINE is None:
        try:
            libc = ctypes.CDLL(None, use_errno=True)
        except OSError as exc:
            fail(EX_USAGE, "cannot load libc: %s" % exc)
        libc.syscall.restype = ctypes.c_long
        _TRAMPOLINE = libc.syscall
    return _TRAMPOLINE


def ns_syscall(op, *args):
    ctypes.set_errno(0)
    ret = _trampoline()(NUMBERS[op], *args)
    if ret == -1:
        code = ctypes.get_errno()
        name = errno.errorcode.get(code, str(code))
        detail = "%s failed with %s (%s)" % (op, name, os.strerror(code))
        if code == errno.ENOSYS:
            fail(EX_MOUNT, detail + "; kernel must be >= 5.2 (open_tree/move_mount missing)")
        if code == errno.EPERM:
            fail(EX_MOUNT, detail + "; run on the host with sudo (CAP_SYS_ADMIN in the"
                 " user namespace owning the target mount namespace)")
        if op == "move_mount" and code == errno.ENOENT:
            fail(EX_TARGET, detail + "; target directory missing in the container's mount namespace")
        if op == "move_mount" and code == errno.ENOTDIR:
            fail(EX_TARGET, detail + "; target is not a directory")
        fail(EX_MOUNT, detail)
    return ret


def _docker(argv):
    try:
        return subprocess.run(["docker"] + argv, capture_output=True, text=True, timeout=30)
    except (FileNotFoundError, PermissionError, OSError) as exc:
        fail(EX_RESOLVE, "docker CLI unusable: %s; pass --pid as an escape hatch" % exc)
    except subprocess.TimeoutExpired:
        fail(EX_RESOLVE, "docker CLI timed out; pass --pid as an escape hatch")


def _compose_project():
    """compose.yaml names the compose project code-conductor."""
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"),
                  encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("COMPOSE_PROJECT_NAME="):
                    return line.split("=", 1)[1].strip().strip('"') or "code-conductor"
    except OSError:
        pass
    return "code-conductor"


def inspect_container(name):
    proc = _docker(["inspect", "--format",
                    "{{.State.Pid}} {{.State.Status}} {{.Config.User}}", name])
    if proc.returncode != 0:
        fail(EX_RESOLVE, "docker inspect %s failed (exit %d): %s"
             % (name, proc.returncode, proc.stderr.strip()))
    fields = proc.stdout.strip().split()
    try:
        pid = int(fields[0])
    except (IndexError, ValueError):
        fail(EX_RESOLVE, "could not parse docker inspect output %r for %s"
             % (proc.stdout.strip(), name))
    status = fields[1] if len(fields) > 1 else "?"
    if pid == 0 or status != "running":
        fail(EX_RESOLVE, "container %s is %s, not running" % (name, status))
    return pid, (fields[2] if len(fields) > 2 else "")


def auto_resolve():
    proc = _docker(["ps",
                    "--filter", "label=com.docker.compose.service=conductor",
                    "--filter", "status=running",
                    "--format", '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project"}} {{.Image}}'])
    if proc.returncode != 0:
        fail(EX_RESOLVE, "docker ps failed (exit %d): %s; pass --pid as an escape hatch"
             % (proc.returncode, proc.stderr.strip()))
    candidates = []
    for line in proc.stdout.strip().splitlines():
        fields = line.split()
        if len(fields) >= 2:
            candidates.append({"name": fields[1],
                               "project": fields[2] if len(fields) > 2 else "",
                               "image": fields[3] if len(fields) > 3 else ""})
    if not candidates:
        fail(EX_RESOLVE, "no running conductor container (service label `conductor`);"
             " run `make up` first, or pass --container/--pid")
    if len(candidates) > 1:
        project = _compose_project()
        narrowed = [c for c in candidates
                    if c["project"] == project or c["image"] == "code-conductor:local"]
        if len(narrowed) != 1:
            fail(EX_RESOLVE, "multiple running conductor containers: %s; pass --container"
                 % ", ".join(c["name"] for c in candidates))
        candidates = narrowed
    return candidates[0]["name"]


def resolve(args):
    """(pid, .Config.User, display label) from --pid / --container / auto-resolution."""
    if args.pid is not None:
        return args.pid, "", "pid %d" % args.pid
    if args.container is not None:
        pid, user = inspect_container(args.container)
        return pid, user, args.container
    name = auto_resolve()
    pid, user = inspect_container(name)
    return pid, user, name


def validate_host_dir(host_dir):
    if not os.path.isabs(host_dir):
        fail(EX_USAGE, "host dir must be absolute: %r" % host_dir)
    try:
        st = os.stat(host_dir)
    except OSError as exc:
        fail(EX_USAGE, "host dir %s is not accessible: %s" % (host_dir, exc))
    if not stat.S_ISDIR(st.st_mode):
        fail(EX_USAGE, "host path %s is not a directory" % host_dir)


def target_name(host_dir):
    name = os.path.basename(host_dir.rstrip("/"))
    if name in ("", ".", ".."):
        fail(EX_USAGE, "cannot derive a target name from %r" % host_dir)
    if name in RESERVED_NAMES:
        fail(EX_USAGE, "target name %r is reserved (/workspaces/projects and"
             " /workspaces/code-conductor are the deployment's own mounts)" % name)
    return name


def create_target(pid, name, user):
    """mkdir + chown the mount point inside the container, pre-setns; EEXIST doubles
    as the collision guard (exit 5, no auto-suffix)."""
    path = "/proc/%d/root/workspaces/%s" % (pid, name)
    # A gone-away pid would otherwise surface as mkdir ENOENT below — target
    # state (exit 5) instead of the bad/exited-pid semantics (exit 3).
    try:
        os.stat("/proc/%d/root" % pid)
    except OSError as exc:
        if exc.errno in (errno.ENOENT, errno.ESRCH):
            fail(EX_RESOLVE, "pid %d: no such process (bad or exited pid)" % pid)
        hint = _PTRACE_HINT % "root" if exc.errno in (errno.EACCES, errno.EPERM) else ""
        fail(EX_RESOLVE, "cannot access pid %d's root: %s%s" % (pid, exc, hint))
    try:
        os.mkdir(path, 0o755)
    except FileExistsError:
        fail(EX_TARGET, "/workspaces/%s already exists in the container; rename or"
             " symlink the host dir to a fresh name instead" % name)
    except OSError as exc:
        fail(EX_TARGET, "cannot create /workspaces/%s in the container: %s" % (name, exc))
    # Cosmetic for the mounted tree (the visible inode is the host dir's);
    # fixes the leftover-empty-dir case. .Config.User is "uid[:gid]"; container
    # /workspaces is root-owned, so projects' owner is the fallback.
    if user:
        parts = user.split(":")
        try:
            uid = int(parts[0])
            gid = int(parts[1]) if len(parts) > 1 else uid
            os.chown(path, uid, gid)
        except (OSError, ValueError) as exc:
            print("cc-mount: warning: chown %s to %r failed: %s" % (path, user, exc),
                  file=sys.stderr)
    else:
        try:
            st = os.stat("/proc/%d/root/workspaces/projects" % pid)
            os.chown(path, st.st_uid, st.st_gid)
        except OSError:
            pass
    return path


def undo_target(path):
    """Remove the created mount point so a failed attempt can't poison retries
    via the EEXIST guard; rmdir only succeeds while it is empty."""
    try:
        os.rmdir(path)
    except OSError:
        pass


def mount_into(pid, host_dir, target, recursive):
    target_fd = own_fd = fd_mnt = None
    switched = False
    try:
        try:
            target_fd = os.open("/proc/%d/ns/mnt" % pid, _RD_CLOEXEC)
            own_fd = os.open("/proc/self/ns/mnt", _RD_CLOEXEC)
        except OSError as exc:
            if exc.errno in (errno.ENOENT, errno.ESRCH):
                fail(EX_RESOLVE, "pid %d: no such process (bad or exited pid)" % pid)
            hint = (_PTRACE_HINT % "namespace fd"
                    if exc.errno in (errno.EACCES, errno.EPERM) else "")
            fail(EX_RESOLVE, "cannot open pid %d's mount namespace: %s%s" % (pid, exc, hint))
        st_t, st_o = os.fstat(target_fd), os.fstat(own_fd)
        flags = OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC
        if recursive:
            flags |= AT_RECURSIVE
        # The detached mount is created in OUR namespace, before any setns:
        # mount(2) must resolve source and target in the caller's namespace, so
        # setns-then-attach would lose the host fd. A detached mount belongs to
        # no namespace and survives the switch (brauner.io, "Mounting into
        # mount namespaces").
        fd_mnt = ns_syscall("open_tree", AT_FDCWD, os.fsencode(host_dir), flags)
        # setns requires CAP_SYS_ADMIN in the user namespace owning the target
        # mntns, evaluated against our unchanged creds.
        if (st_t.st_dev, st_t.st_ino) != (st_o.st_dev, st_o.st_ino):
            ns_syscall("setns", target_fd, CLONE_NEWNS)
            switched = True
        ns_syscall("move_mount", fd_mnt, b"", AT_FDCWD, os.fsencode(target),
                   MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_SYMLINKS)
    except SystemExit:
        # A cross-ns setns put us in the container's pid namespace: its procfs
        # has no /proc/<host-pid>, so /proc/<pid>/root no longer resolves and
        # main's undo would silently fail — switch back while own_fd is open.
        if switched:
            try:
                ns_syscall("setns", own_fd, CLONE_NEWNS)
            except SystemExit:
                pass
        raise
    finally:
        for fd in (fd_mnt, target_fd, own_fd):
            if fd is not None:
                os.close(fd)


def run_check(args):
    failures = []

    def line(label, state, detail=""):
        print("  %-10s %-4s %s" % (label, state, detail))
        if state == "FAIL":
            failures.append(label)

    if sys.platform != "linux" or NUMBERS is None:
        line("platform", "FAIL", _PLATFORM_FAIL)
    else:
        line("platform", "ok", "linux %s" % platform.machine())

    name = None
    try:
        validate_host_dir(args.host_dir)
        name = target_name(args.host_dir)
        line("host-dir", "ok", "%s -> /workspaces/%s" % (args.host_dir, name))
    except SystemExit:
        line("host-dir", "FAIL", "see the cc-mount: line above")

    if NUMBERS is not None and name is not None:
        ctypes.set_errno(0)
        ret = _trampoline()(NUMBERS["open_tree"], AT_FDCWD,
                            os.fsencode(args.host_dir), OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC)
        if ret >= 0:
            os.close(ret)
            line("kernel", "ok", "open_tree works (kernel >= 5.2)")
        else:
            code = ctypes.get_errno()
            if code == errno.ENOSYS:
                line("kernel", "FAIL", "open_tree missing: kernel < 5.2")
            elif code == errno.EPERM:
                line("kernel", "ok", "open_tree present; mounting needs sudo/CAP_SYS_ADMIN")
            else:
                line("kernel", "FAIL", "open_tree: %s" % os.strerror(code))
    else:
        line("kernel", "SKIP", "needs a supported platform and a valid host dir")

    pid = None
    try:
        pid, user, label = resolve(args)
        line("docker", "ok", "%s (pid %d, running)" % (label, pid))
    except SystemExit:
        line("docker", "FAIL", "see the cc-mount: line above")

    if pid is not None and name is not None:
        base = "/proc/%d/root/workspaces" % pid
        try:
            st = os.stat(base)
            if not stat.S_ISDIR(st.st_mode):
                line("target", "FAIL", "%s is not a directory in the container" % base)
            elif os.path.lexists("%s/%s" % (base, name)):
                line("target", "FAIL", "/workspaces/%s already exists in the container" % name)
            else:
                line("target", "ok", "/workspaces/%s free" % name)
        except OSError as exc:
            if exc.errno in (errno.EACCES, errno.EPERM):
                line("target", "SKIP", "cannot read the container fs unprivileged: %s" % exc)
            else:
                line("target", "FAIL", str(exc))
    else:
        line("target", "SKIP", "needs a resolved container and a valid host dir")

    if failures:
        print("cc-mount: check FAILED: %s" % ", ".join(failures), file=sys.stderr)
        return 1
    print("cc-mount: check passed")
    return 0


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="cc-mount",
        description="Bind-mount a host directory into the running code-conductor"
        " container (see docker/README.md).",
    )
    parser.add_argument("-r", "--recursive", action="store_true",
                        help="include submounts under HOST-DIR (rbind; default excludes them)")
    parser.add_argument("--container", metavar="NAME",
                        help="container name/ID instead of auto-resolution (passed to docker verbatim)")
    parser.add_argument("--pid", type=int, metavar="PID",
                        help="target PID directly; skips docker entirely")
    parser.add_argument("--check", action="store_true",
                        help="report the environment (platform, kernel, docker, host dir,"
                        " target) without mounting")
    parser.add_argument("host_dir", metavar="HOST-DIR",
                        help="host directory to mount (lands at /workspaces/<basename>)")
    args = parser.parse_args(argv)
    if args.container is not None and args.pid is not None:
        parser.error("--container and --pid are mutually exclusive")
    if args.pid is not None and args.pid <= 0:
        parser.error("--pid must be a positive PID (got %d)" % args.pid)
    return args


def main(argv=None):
    args = parse_args(argv)
    if args.check:
        return run_check(args)
    if sys.platform != "linux" or NUMBERS is None:
        fail(EX_USAGE, _PLATFORM_FAIL)

    validate_host_dir(args.host_dir)
    name = target_name(args.host_dir)
    target = "/workspaces/" + name
    pid, user, label = resolve(args)
    created = create_target(pid, name, user)
    try:
        mount_into(pid, args.host_dir, target, args.recursive)
    except SystemExit:
        undo_target(created)
        raise
    print("cc-mount: %s mounted at %s in %s (container pid %d)"
          % (args.host_dir, target, label, pid))
    print("cc-mount: not visible to `docker inspect .Mounts`; gone on container restart")
    return 0


if __name__ == "__main__":
    sys.exit(main())
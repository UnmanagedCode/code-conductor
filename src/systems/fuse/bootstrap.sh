#!/bin/sh
# Runs as root inside a fresh private mount namespace, created by
# `sudo -n -E unshare --mount --propagation private` (see wrap.ts). Mounts the
# union, records the handshake, drops privilege, chroots, and EXECS the CLI.
#
# IT OWNS NO TEARDOWN. Step 10 execs into `claude` and this script ceases to
# exist as a supervisor, which is deliberate: a shell trap cannot survive
# SIGKILL, so a teardown here would be a second, weaker copy of the state
# machine in session.ts. cc's FuseSession is the only implementation.
#
# The ordering below IS the design. Every step is numbered to the plan.
#
# Exit 78 (EX_CONFIG) is this script's own refusal; anything else came from the
# chain it exec'd into. cc captures stderr as `system/stderr` events.

set -eu

die() { echo "cc-fuse-bootstrap: REFUSED — $*" >&2; exit 78; }

# ── 1. re-assert preflight, as defence in depth. cc checked all of this before
#       spawning; between that check and here the host can have changed, and a
#       named refusal on stderr beats a mount that half-happens.
[ -c /dev/fuse ] || die "/dev/fuse is missing or is not a character device"
[ "$(id -u)" = 0 ] || die "not running as uid 0 — sudo/unshare did not take"
for b in mount umount chroot setpriv; do
	command -v "$b" >/dev/null 2>&1 || die "\`$b\` is not on PATH"
done
# RESOLVED HERE, ABSOLUTELY, and exec'd by these paths at step 10. That step
# restores a CALLER-SUPPLIED PATH immediately before exec'ing as uid 0, so a
# bare name there would be resolved against it. This probe already ran; capture
# what it found rather than looking again through a different PATH.
CHROOT_BIN=$(command -v chroot)
SETPRIV_BIN=$(command -v setpriv)
grep -q '[[:space:]]fusectl$' /proc/filesystems || die "fusectl is not in /proc/filesystems"
[ -x "$CC_FUSE_BIN" ] || die "union binary $CC_FUSE_BIN is missing or not executable"
[ -r "$CC_FUSE_PINS" ] || die "pins file $CC_FUSE_PINS is unreadable"
# cc listens on this before it spawns us, and the daemon refuses to mount
# without it. A named refusal here beats the daemon's, which arrives inside the
# mount-wait loop at step 5.
[ -S "$CC_FUSE_CONTROL" ] || die "cc's control socket $CC_FUSE_CONTROL is missing or is not a socket"

# ── 2. the scaffolding. cc created these dirs so every file under the run
#       directory is cc-owned and cc can reclaim the tree without sudo; this is
#       a safety net for a partial one, never the primary creator.
mkdir -p "$CC_FUSE_ROOT" "$CC_FUSE_MIRROR" "$CC_FUSE_FUSECTL"

# ── 2a. THE RECORD WRITER, and THE INVARIANT IT ENFORCES:
#
#        NOTHING THIS SCRIPT STARTS MAY PRECEDE THE RECORD THAT NAMES IT.
#
#        cc's teardown and its boot sweep both iterate RECORDS. A process
#        started before the record that names it — and there were two, the
#        anchor and the daemon, both started long before the single write at
#        step 7 — is unreclaimable by name if this script then dies: cc reads
#        intent.json, finds no pid to signal, and reclaims the run directory,
#        destroying the only handle on a process that is still running.
#        Measured as a real leak (a root `sleep infinity` holding a live private
#        mount namespace, orphaned to pid 1, with its record already deleted).
#
#        So the record is written THREE times — after the anchor, after the
#        daemon, and once the mount is up — each write atomic (tmp + rename) and
#        each naming everything known so far. `stage` is what cc's handshake
#        waits for: `starting` means "processes exist, tear them down if you
#        must", `mounted` means "and the mount is up".
procstart() { awk '{ p = index($0, ")"); split(substr($0, p + 2), f, " "); print f[20] }' "/proc/$1/stat" 2>/dev/null; }

ANCHOR_PID=0
DAEMON_PID=0
MINOR=""
NS_MNT=""
MOUNTED_AT=0
write_record() { # write_record <stage>
	cat > "$CC_FUSE_RECORD.tmp" <<JSON
{
  "schema": 1,
  "stage": "$1",
  "instanceId": "$CC_FUSE_INSTANCE_ID",
  "ccBootId": "$CC_FUSE_BOOT_ID",
  "rundir": "$CC_FUSE_RUNDIR",
  "root": "$CC_FUSE_ROOT",
  "mirror": "$CC_FUSE_MIRROR",
  "fusectl": "$CC_FUSE_FUSECTL",
  "nsMntId": "$NS_MNT",
  "bootstrapPid": $$,
  "bootstrapStart": "$(procstart $$)",
  "anchorPid": $ANCHOR_PID,
  "anchorStart": "$(procstart "$ANCHOR_PID")",
  "daemonPid": $DAEMON_PID,
  "daemonStart": "$(procstart "$DAEMON_PID")",
  "minor": "$MINOR",
  "spawnedAt": ${CC_FUSE_SPAWNED_AT:-0},
  "mountedAt": $MOUNTED_AT
}
JSON
	mv -f "$CC_FUSE_RECORD.tmp" "$CC_FUSE_RECORD"
	chown "$CC_FUSE_UID:$CC_FUSE_GID" "$CC_FUSE_RECORD" 2>/dev/null || true
}

# ── 2b. THE NAMESPACE ANCHOR, and it is a measured necessity rather than a
#        convenience. cc reaches this namespace with
#        `nsenter --mount=/proc/<pid>/ns/mnt`, and that open is governed by
#        ptrace_may_access: a process that has changed credentials is
#        non-dumpable (this host: /proc/sys/fs/suid_dumpable = 2), and opening a
#        non-dumpable process's ns/* then needs CAP_SYS_PTRACE — which is NOT in
#        this container's bounding set, so not even uid 0 has it. The daemon
#        calls setfsuid per request and the worker is setpriv'd, so BOTH become
#        unreachable within milliseconds of the mount coming up. Measured: the
#        first nsenter after the handshake succeeds and every later one fails
#        `cannot open /proc/<pid>/ns/mnt: Permission denied`.
#
#        The anchor is a process that never changes credentials, so it stays
#        dumpable and its ns/mnt stays openable by root for the life of the
#        namespace. It is NOT a supervisor: it holds no state, watches nothing,
#        and cannot restart anything — it is a handle. cc's teardown kills it
#        last, and the boot sweep kills one cc crashed before reaching.
setsid sleep infinity </dev/null >/dev/null 2>&1 &
ANCHOR_PID=$!
write_record starting

# ── 3. (was the S1 stand-in bind mount.) There is nothing to place behind the
#       mirror any more: cc materialises every remote path into it over the
#       control channel, and a bind here would be a second mechanism.

# ── 4. the daemon. Root, and it stays root: S1 §7.2 measured that a
#       non-root daemon breaks the CLI's own Bash tool with EACCES on
#       /tmp/claude-1000. `allow_other,default_permissions` plus per-request
#       setfsuid/setfsgid is what lets one daemon serve callers of another uid.
#       CC_UNION_TRACE MUST BE ABSENT, NOT EMPTY, when tracing is off, and it
#       cannot ride as a command prefix like the others for that reason: the
#       daemon tests the POINTER (`if (tp)`, union.c), and an empty string is a
#       non-NULL pointer in C — it would `fopen("")`, fail ENOENT and REFUSE TO
#       MOUNT, on every ordinary spawn. `set -u` above is the second reason the
#       reference is defaulted rather than bare.
#
#       THE INPUT IS A PATH, NOT A FLAG. `CC_FUSE_TRACE_LOG` is set by
#       `wrapLaunch` only when cc decided tracing is on, and stripped otherwise;
#       cc's own on/off switch is `CC_FUSE_TRACE`, which nothing here reads. A
#       non-emptiness test on a PATH is exact — where the same test on a flag
#       accepted "0".
#
#       THE `else` ARM IS LOAD-BEARING: sudo -E carries the orchestrator's whole
#       environment through, so an ambient CC_UNION_TRACE would otherwise reach
#       the daemon on a spawn where cc chose no tracing at all. This is the one
#       place the daemon's environment is composed, so it is the one place that
#       can be sure.
if [ -n "${CC_FUSE_TRACE_LOG:-}" ]; then
	export CC_UNION_TRACE="$CC_FUSE_TRACE_LOG"
else
	unset CC_UNION_TRACE || :
fi
CC_UNION_HOST_ROOT=/ \
CC_UNION_REMOTE="$CC_FUSE_MIRROR" \
CC_UNION_PINS="$CC_FUSE_PINS" \
CC_UNION_MNT="$CC_FUSE_ROOT" \
CC_UNION_CONTROL="$CC_FUSE_CONTROL" \
CC_UNION_MARK_PATH="$CC_FUSE_MARK_PATH" \
CC_UNION_EVENTS="$CC_FUSE_EVENT_LOG" \
	"$CC_FUSE_BIN" -f -o "$CC_FUSE_MOUNT_OPTS" "$CC_FUSE_ROOT" \
	>"$CC_FUSE_DAEMON_LOG" 2>&1 &
DAEMON_PID=$!
#       Off the CLI's exec, which the CC_FUSE_* variables do ride on.
unset CC_UNION_TRACE || :
write_record starting

# ── 5. wait for the mount, via /proc/self/mounts and NEVER `mountpoint -q`:
#       mountpoint stat()s the path, and reports "not mounted" for exactly the
#       stale-transport case cleanup exists for.
is_mounted() { awk -v p="$1" '$2 == p { f = 1 } END { exit !f }' /proc/self/mounts; }
i=0
while [ "$i" -lt 100 ]; do
	if is_mounted "$CC_FUSE_ROOT"; then break; fi
	if ! kill -0 "$DAEMON_PID" 2>/dev/null; then break; fi
	sleep 0.05
	i=$((i + 1))
done
if ! is_mounted "$CC_FUSE_ROOT"; then
	echo "cc-fuse-bootstrap: REFUSED — the union did not mount at $CC_FUSE_ROOT; daemon log follows" >&2
	tail -40 "$CC_FUSE_DAEMON_LOG" >&2 || true
	exit 78
fi

# ── 6. CAPTURE THE CONNECTION MINOR NOW, while the mount exists. Resolving it
#       from mountinfo BY MOUNTPOINT is only possible here: the same lookup run
#       during teardown — after the unmount — is a silent no-op, which is the
#       defect that made S2's own abort path do nothing (S3 §A4 step 1).
MINOR=$(awk -v p="$CC_FUSE_ROOT" '$5 == p { print $3; exit }' /proc/self/mountinfo)
MINOR=${MINOR#*:}
[ -n "$MINOR" ] || die "could not capture the connection minor for $CC_FUSE_ROOT"

# ── 7. the handshake, which is the THIRD write of the record rather than its
#       first (see step 2a). `stage: mounted` is what cc's awaitHandshake waits
#       for; the two earlier writes already made every process reclaimable.
#       Every pid carries its /proc/<pid>/stat field 22 starttime, so "still
#       there" can never be satisfied by a recycled pid wearing the number.
NS_MNT=$(readlink /proc/self/ns/mnt 2>/dev/null || echo "")
MOUNTED_AT=$(date +%s%3N)
write_record mounted

# ── 8. fusectl at a PRIVATE path, not /sys/fs/fuse/connections. A read-only
#       /sys can be mounted over (S3 §A1 rung 2) — this declines to, because
#       step 9 binds /sys into the chroot and fusectl at its conventional path
#       would hand the worker both a tell that its root is FUSE and an abort
#       surface against its own filesystem. $CC_FUSE_FUSECTL is OUTSIDE
#       $CC_FUSE_ROOT, so it is invisible inside the chroot and reachable by cc
#       through nsenter.
mount -t fusectl none "$CC_FUSE_FUSECTL" || die "could not mount fusectl at $CC_FUSE_FUSECTL"

# ── 9. real bind mounts OVER the union, after it is up and NEVER as tiers. A
#       passthrough serving /proc/self/* answers with the DAEMON's identity and
#       breaks /proc/self/exe, which is how a bun single-file executable finds
#       its embedded payload (S1 §7.1, measured). The three targets are the
#       `bind` tier: the union serves each as a read-only synthetic directory
#       purely so this bind has something to land on.
mount --bind /proc "$CC_FUSE_ROOT/proc" || die "could not bind /proc into the chroot"
mount --bind /sys  "$CC_FUSE_ROOT/sys"  || die "could not bind /sys into the chroot"
mount --rbind /dev "$CC_FUSE_ROOT/dev"  || die "could not bind /dev into the chroot"

# ── 10. drop privilege, chroot, exec. WITHOUT the privilege drop the CLI writes
#        root-owned files into the real ~/.claude. `exec` at every link keeps
#        cc's three pipes attached and leaves this pid — recorded above as
#        `bootstrapPid` — as the CLI's own.
PATH="${CC_FUSE_PATH:-$PATH}"
export PATH
exec "$CHROOT_BIN" "$CC_FUSE_ROOT" /bin/sh -c '
	# THE MARKING EVENT, FIRED DELIBERATELY AND BEFORE THE cd.
	#
	# The union serves a project path only to a thread group marked as the
	# CLI, and a thread group is marked the first time it resolves the CLI
	# binary. Every link from here on — this shell, setpriv, the CLI — is the
	# SAME pid, because each one execs, and exec preserves the thread group
	# and its start time. So marking here marks the CLI.
	#
	# Without it the FIRST union op this pid makes is the `cd` below, into
	# the project tree, unmarked — and the launch dies "cwd does not exist
	# inside the chroot" before the CLI is ever reached. Waiting for the
	# loader to read the binary incidentally is one op too late, and it also
	# leaves the pre-mark window S1 §9.1 measured wide open.
	#
	# A plain existence test: the daemon marks on RESOLUTION, so a stat is
	# the whole event. `|| :` because the mark path is host-pinned and an
	# unreadable one is the daemon`s refusal to report, not this shell`s.
	[ -e "$5" ] || :
	cd "$2" || { echo "cc-fuse-bootstrap: REFUSED — cwd $2 does not exist inside the chroot" >&2; exit 78; }
	sp=$1; u=$3; g=$4
	shift 5
	exec "$sp" --reuid="$u" --regid="$g" --init-groups -- "$@"
' sh "$SETPRIV_BIN" "$CC_FUSE_CWD" "$CC_FUSE_UID" "$CC_FUSE_GID" "$CC_FUSE_MARK_PATH" "$@"

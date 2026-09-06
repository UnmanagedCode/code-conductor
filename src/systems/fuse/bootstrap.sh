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
grep -q '[[:space:]]fusectl$' /proc/filesystems || die "fusectl is not in /proc/filesystems"
[ -x "$CC_FUSE_BIN" ] || die "union binary $CC_FUSE_BIN is missing or not executable"
[ -r "$CC_FUSE_PINS" ] || die "pins file $CC_FUSE_PINS is unreadable"

# ── 2. the scaffolding. cc created these dirs so every file under the run
#       directory is cc-owned and cc can reclaim the tree without sudo; this is
#       a safety net for a partial one, never the primary creator.
mkdir -p "$CC_FUSE_ROOT" "$CC_FUSE_MIRROR" "$CC_FUSE_FUSECTL"

# ── 3. THE S1 STAND-IN, and it is labelled one. There is no transport and no
#       control channel in S1: the daemon's remote tier is a plain local
#       directory, and this bind is what puts real bytes behind it at the
#       project's own remote-space path. S3 replaces this with cc materialising
#       files into the same directory over the control channel. It proves the
#       mirror's placement, its `hide` tiering and its cleanup — and NO
#       transport, NO latency, NO channel.
if [ -n "${CC_FUSE_STANDIN_SRC:-}" ] && [ -n "${CC_FUSE_STANDIN_AT:-}" ]; then
	mount --bind "$CC_FUSE_STANDIN_SRC" "$CC_FUSE_STANDIN_AT" \
		|| die "could not bind the stand-in remote $CC_FUSE_STANDIN_SRC at $CC_FUSE_STANDIN_AT"
fi

# ── 4. the daemon. Root, and it stays root: S1 §7.2 measured that a
#       non-root daemon breaks the CLI's own Bash tool with EACCES on
#       /tmp/claude-1000. `allow_other,default_permissions` plus per-request
#       setfsuid/setfsgid is what lets one daemon serve callers of another uid.
FUSE_S3_HOST_ROOT=/ \
FUSE_S3_REMOTE="$CC_FUSE_MIRROR" \
FUSE_S3_PINS="$CC_FUSE_PINS" \
FUSE_S3_MNT="$CC_FUSE_ROOT" \
	"$CC_FUSE_BIN" -f -o "$CC_FUSE_MOUNT_OPTS" "$CC_FUSE_ROOT" \
	>"$CC_FUSE_DAEMON_LOG" 2>&1 &
DAEMON_PID=$!

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

NS_MNT=$(readlink /proc/self/ns/mnt 2>/dev/null || echo "")
procstart() { awk '{ p = index($0, ")"); split(substr($0, p + 2), f, " "); print f[20] }' "/proc/$1/stat" 2>/dev/null; }

# ── 7. the handshake record, atomically (tmp + rename — the pattern
#       resumeManifest.ts already uses) and chowned back to cc, which rewrites
#       it in place when teardown wedges. Every pid carries its
#       /proc/<pid>/stat field 22 starttime, so "still there" can never be
#       satisfied by a recycled pid wearing the number.
cat > "$CC_FUSE_RECORD.tmp" <<JSON
{
  "schema": 1,
  "instanceId": "$CC_FUSE_INSTANCE_ID",
  "ccBootId": "$CC_FUSE_BOOT_ID",
  "rundir": "$CC_FUSE_RUNDIR",
  "root": "$CC_FUSE_ROOT",
  "mirror": "$CC_FUSE_MIRROR",
  "fusectl": "$CC_FUSE_FUSECTL",
  "nsMntId": "$NS_MNT",
  "bootstrapPid": $$,
  "bootstrapStart": "$(procstart $$)",
  "daemonPid": $DAEMON_PID,
  "daemonStart": "$(procstart "$DAEMON_PID")",
  "minor": "$MINOR",
  "spawnedAt": ${CC_FUSE_SPAWNED_AT:-0},
  "mountedAt": $(date +%s%3N)
}
JSON
mv -f "$CC_FUSE_RECORD.tmp" "$CC_FUSE_RECORD"
chown "$CC_FUSE_UID:$CC_FUSE_GID" "$CC_FUSE_RECORD" 2>/dev/null || true

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
#       its embedded payload (S1 §7.1, measured).
mount --bind /proc "$CC_FUSE_ROOT/proc" || die "could not bind /proc into the chroot"
mount --bind /sys  "$CC_FUSE_ROOT/sys"  || die "could not bind /sys into the chroot"
mount --rbind /dev "$CC_FUSE_ROOT/dev"  || die "could not bind /dev into the chroot"

# ── 10. drop privilege, chroot, exec. WITHOUT the privilege drop the CLI writes
#        root-owned files into the real ~/.claude. `exec` at every link keeps
#        cc's three pipes attached and leaves this pid — recorded above as
#        `bootstrapPid` — as the CLI's own.
PATH="${CC_FUSE_PATH:-$PATH}"
export PATH
exec chroot "$CC_FUSE_ROOT" /bin/sh -c '
	cd "$1" || { echo "cc-fuse-bootstrap: REFUSED — cwd $1 does not exist inside the chroot" >&2; exit 78; }
	u=$2; g=$3
	shift 3
	exec setpriv --reuid="$u" --regid="$g" --init-groups -- "$@"
' sh "$CC_FUSE_CWD" "$CC_FUSE_UID" "$CC_FUSE_GID" "$@"

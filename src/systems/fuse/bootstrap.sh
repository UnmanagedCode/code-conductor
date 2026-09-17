#!/bin/sh
# Runs as root inside a fresh private mount namespace, created by
# `sudo -n unshare --mount --propagation private` (see wrap.ts). Mounts the
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

# ── 0. THE ENVIRONMENT FILES, AND WHY THEY ARE FILES. Nothing cc means this
#       script or the CLI to have travels through sudo: `-E` — like a
#       `VAR=value` argv prefix — needs the sudoers SETENV: tag, and requiring
#       that of every host running cc is a cost cc declines. It writes two
#       0600 files into the run directory it already owns and passes the
#       FIRST one's path POSITIONALLY; the second's path is a key in the first.
#       Values are shell-quoted by `renderEnvFile` (wrap.ts), so a newline, a
#       quote or a `$` round-trips.
#
#       A PATH IN ARGV IS NOT A SECRET. /proc/<pid>/cmdline is world-readable;
#       the 0600 file it names is not.
#
#       SOURCED AS ROOT, BEFORE THE PRIVILEGE DROP, deliberately. The writer is
#       cc and the file is cc-owned and not group/other-writable — which is what
#       the check below establishes — so reopening after the drop would buy
#       nothing the ownership test does not already give.
#
#       PATH IS NOT IN THE PLAN SET, and must never be added: step 1's
#       `command -v` probes resolve against sudo's secure_path, and the CLI's
#       own PATH arrives with the worker set at step 10.
[ $# -ge 2 ] || die "usage: bootstrap.sh <plan-env-file> <cc-uid> <command> [args...]"
PLAN_ENV=$1
EXPECT_UID=$2
shift 2
command -v stat >/dev/null 2>&1 || die "\`stat\` is not on PATH"
check_env_file() { # check_env_file <path> <expected-uid>
	[ -f "$1" ] || die "environment file $1 is missing or is not a regular file"
	_o=$(stat -c %u "$1" 2>/dev/null) || die "could not stat environment file $1"
	[ "$_o" = "$2" ] || die "environment file $1 is owned by uid $_o, not by cc's uid $2"
	_m=$(stat -c %04a "$1" 2>/dev/null) || die "could not stat environment file $1"
	# `%04a` is fixed-width, so character 3 is the group triad and character 4 the
	# other triad, and `2367` is every octal digit carrying the write bit.
	case "$_m" in
		??[2367]?|???[2367]) die "environment file $1 is group- or other-writable (mode $_m)" ;;
	esac
}
check_env_file "$PLAN_ENV" "$EXPECT_UID"
. "$PLAN_ENV"
# ONE FACT WITH TWO SPELLINGS, rather than two that can drift apart.
[ "${CC_FUSE_UID:-}" = "$EXPECT_UID" ] \
	|| die "plan file $PLAN_ENV says uid ${CC_FUSE_UID:-<unset>}, argv says $EXPECT_UID"
[ -n "${CC_FUSE_WORKER_ENV:-}" ] || die "plan file $PLAN_ENV names no worker environment file"
# CHECKED HERE, SOURCED AT STEP 10: a bad worker file must refuse before the
# mount exists, not after.
check_env_file "$CC_FUSE_WORKER_ENV" "$EXPECT_UID"

# ── 1. re-assert preflight, as defence in depth. cc checked all of this before
#       spawning; between that check and here the host can have changed, and a
#       named refusal on stderr beats a mount that half-happens.
[ -c /dev/fuse ] || die "/dev/fuse is missing or is not a character device"
[ "$(id -u)" = 0 ] || die "not running as uid 0 — sudo/unshare did not take"
for b in mount umount chroot setpriv; do
	command -v "$b" >/dev/null 2>&1 || die "\`$b\` is not on PATH"
done
# RESOLVED HERE, ABSOLUTELY, and exec'd by these paths at step 10. That step
# sources a CALLER-SUPPLIED PATH immediately before exec'ing as uid 0, so a
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

# ── 3. NOTHING IS BIND-MOUNTED BEHIND THE MIRROR. cc materialises every remote
#       path into it over the control channel, and a bind here would be a
#       second mechanism for the same job.

# ── 4. the daemon. Root, and it stays root: a non-root daemon breaks the CLI's
#       own Bash tool with EACCES on its per-uid tmp root. `allow_other,default_permissions` plus per-request
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
#       THE GUARD HAS ONE ARM BECAUSE THE DAEMON'S ENVIRONMENT IS COMPOSED,
#       NOT DEFENDED. What reaches this line is sudo's own env_reset output plus
#       the plan file sourced at step 0 — cc hands sudo nothing but the PATH
#       node needs to find it (wrap.ts) — so no ambient CC_UNION_TRACE of cc's
#       exists for a second arm to clear. Hand sudo cc's environment again and
#       that stops being true.
if [ -n "${CC_FUSE_TRACE_LOG:-}" ]; then
	export CC_UNION_TRACE="$CC_FUSE_TRACE_LOG"
fi
CC_UNION_HOST_ROOT=/ \
CC_UNION_REMOTE="$CC_FUSE_MIRROR" \
CC_UNION_PINS="$CC_FUSE_PINS" \
CC_UNION_MNT="$CC_FUSE_ROOT" \
CC_UNION_CONTROL="$CC_FUSE_CONTROL" \
CC_UNION_MARK_PATH="$CC_FUSE_MARK_PATH" \
CC_UNION_CWD="$CC_FUSE_CWD" \
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
#       during teardown — after the unmount — is a silent no-op, which makes an
#       abort path that resolves it there do nothing at all.
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
#       /sys can be mounted over — this declines to, because
#       step 9 binds /sys into the chroot and fusectl at its conventional path
#       would hand the worker both a tell that its root is FUSE and an abort
#       surface against its own filesystem. $CC_FUSE_FUSECTL is OUTSIDE
#       $CC_FUSE_ROOT, so the union serves no spelling of it to a caller inside
#       the chroot, and cc reaches it through nsenter. (NOT "invisible inside
#       the chroot": the bind-mounted /proc gives it another spelling at
#       /proc/<ccpid>/root/$CC_FUSE_FUSECTL.)
mount -t fusectl none "$CC_FUSE_FUSECTL" || die "could not mount fusectl at $CC_FUSE_FUSECTL"

# ── 9. real bind mounts OVER the union, after it is up and NEVER as tiers. A
#       passthrough serving /proc/self/* answers with the DAEMON's identity and
#       breaks /proc/self/exe, which is how a bun single-file executable finds
#       its embedded payload. The three targets are the
#       `bind` tier: the union serves each as a read-only synthetic directory
#       purely so this bind has something to land on.
mount --bind /proc "$CC_FUSE_ROOT/proc" || die "could not bind /proc into the chroot"
mount --bind /sys  "$CC_FUSE_ROOT/sys"  || die "could not bind /sys into the chroot"
mount --rbind /dev "$CC_FUSE_ROOT/dev"  || die "could not bind /dev into the chroot"

# ── 10. drop privilege, chroot, exec. WITHOUT the privilege drop the CLI writes
#        root-owned files into the real ~/.claude. `exec` at every link keeps
#        cc's three pipes attached and leaves this pid — recorded above as
#        `bootstrapPid` — as the CLI's own.
#
#        THE WORKER'S OWN ENVIRONMENT IS COMPOSED HERE AND NOWHERE EARLIER.
#        Sourced early, its PATH would be what step 1's `command -v` probes
#        resolved against; sourced here it is an ordinary key and PATH needs no
#        smuggling alias. Everything below this line is `exec`, so what this
#        shell holds is what the CLI runs with.
#
#        THE unset IS SUDO'S OWN env_reset SUBSTITUTIONS (HOME=/root and
#        friends). cc's set overwrites each of them; unsetting first is what
#        makes that true rather than probable, and a missing HOME is a loud
#        failure where a root one is a silent wrong answer.
unset HOME MAIL LOGNAME USER SHELL || :
. "$CC_FUSE_WORKER_ENV"
#        RE-ASSERTED AFTER THE SOURCE: the worker set is cc's process
#        environment, so an operator who exported one of these names would
#        otherwise replace the absolute path step 1 resolved.
[ -x "$CHROOT_BIN" ] || die "chroot binary $CHROOT_BIN is missing or not executable"
[ -x "$SETPRIV_BIN" ] || die "setpriv binary $SETPRIV_BIN is missing or not executable"
exec "$CHROOT_BIN" "$CC_FUSE_ROOT" /bin/sh -c '
	# NOTHING HERE FIRES THE MARKING EVENT, AND THAT IS THE DESIGN.
	#
	# WHAT MARKS: the CLI reading its own binary. The daemon marks a thread
	# group the first time it RESOLVES $CC_UNION_MARK_PATH, and the kernel
	# resolves that path as the first step of the CLI`s own execve — so the
	# marking event is the CLI`s, and the marked population is the CLI`s
	# thread group plus whatever it goes on to read in place. A symlinked
	# launcher marks on the LINK, which is the spelling cc registers, and the
	# target`s chain is then walked marked (real gate R16).
	#
	# WHAT IS DELIBERATELY UNMARKED, and each is a process that has no
	# business resolving in the CLI`s view: this shell, setpriv below, and
	# the backend launch command setpriv execs — which resolves its own name
	# against $PATH and reads its own libraries and $HOME state.
	# Unmarked callers resolve in VIEW_HOST, where the remote tier is struck
	# entirely and an unpinned path is served from the orchestrator instead
	# of denied, so all three run against the machine they belong to.
	#
	# THE cd IS ANSWERED BY THE CWD CHAIN, NOT BY A MARK. Every component of
	# $CC_FUSE_CWD is traversable to an unmarked caller — the orchestrator`s
	# own directory floored to --x, or a traverse-only overlay node where it
	# has none (`policy_cwd_component` + resolve_class`s VIEW_HOST clause,
	# policy.h). This shell is still root here, and the chain does not vary
	# with the advertised mirror root.
	#
	# RESIDUAL, DISCLOSED RATHER THAN DESIGNED AROUND: the mark fires on
	# RESOLUTION, so any process that merely stats the launcher marks ITSELF
	# — a backend that probes for `claude` on PATH before forking, say. It
	# cannot leave the CLI unmarked (a forked child is a fresh thread group
	# and marks itself at its own execve), and $CC_FUSE_EVENT_LOG`s tgid and
	# comm columns name it directly if it ever bites.
	cd "$2" || { echo "cc-fuse-bootstrap: REFUSED — cwd $2 does not exist inside the chroot" >&2; exit 78; }
	sp=$1; u=$3; g=$4
	shift 4
	exec "$sp" --reuid="$u" --regid="$g" --init-groups -- "$@"
' sh "$SETPRIV_BIN" "$CC_FUSE_CWD" "$CC_FUSE_UID" "$CC_FUSE_GID" "$@"

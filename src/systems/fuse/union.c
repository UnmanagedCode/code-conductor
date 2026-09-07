/*
 * fuse-union-s3.c — S3 spike instrument, NOT production code.
 *
 * SEEDED FROM rig/fuse-union.c (the S2 instrument), WHICH IT DOES NOT MODIFY.
 * rig/RESULTS-fuse-union-s2.md names fuse-union.c as the thing it measured, and
 * a recorded run whose instrument changed underneath it is not a recorded run.
 * Same reasoning S2 applied to S1's fuse-passthrough.c. The environment prefix
 * is renamed FUSE_S2_* -> FUSE_S3_* so the two instruments cannot be driven by
 * one environment by accident.
 *
 * S3 adds three things to S2's union, and fixes one defect in it.
 *
 *   1. CALLER IDENTITY IN THE TRACE. Every op records the caller's exe (or its
 *      cmdline[0] where /proc/<tgid>/exe is unrenderable across the chroot) and
 *      a WOULD-BE CLAUDE MARK, so "which process touched which unpinned path"
 *      is answered from a log rather than by inspection. S2 §9 measured this
 *      offline from a trace; here it is online and can be routed on.
 *
 *   2. THREE ROUTING MODES, $FUSE_S3_ROUTE, over one identical workload:
 *        path           S2 semantics. The mark is computed and logged, never
 *                       routed on. The baseline.
 *        marked         THE INVERTED DEFAULT: the default tier reaches the
 *                       remote only for a caller marked CLAUDE; an unmarked
 *                       caller is served the host. Fails safe -- an unmarked
 *                       process can never mutate the remote. Project tier
 *                       unchanged.
 *        marked-strict  inversion applies to the project tier too: an unmarked
 *                       caller gets ENOENT there. This is the COHERENCE arm.
 *                       Under a rule that says "nothing is remote unless the
 *                       caller is marked", an unmarked hook reading a project
 *                       file must get either ENOENT or the remote copy, and the
 *                       rule is undefined until that is measured.
 *
 *   3. PID-REUSE VALIDATION, $FUSE_S3_MARK_VALIDATE. A marked TGID that exits
 *      can have its pid recycled, and FUSE gets no process-exit notification,
 *      so the successor inherits CLAUDE status. S2 §11.7 reasoned this and
 *      never reproduced it. Both halves are built here so the hole and its fix
 *      can be measured against each other:
 *        cached   starttime read once per pid when the cache is filled. Keeps
 *                 S2 §9.3's 99.31% amortisation. UNSOUND under pid reuse.
 *        always   /proc/<pid>/stat field 22 re-read and compared on every
 *                 marked-check. SOUND, and the cost is the measurement.
 *
 * ── the defect this instrument fixes in S2's ───────────────────────────────
 *
 * S2's pcache is keyed on pid with NO starttime validation and never evicts, so
 * a recycled pid returns its predecessor's tgid for the life of the daemon.
 * In S2 that could only mis-fire the self-recursion guard, which fails safe (an
 * over-broad guard serves the host, the default tier's fallback anyway) -- so
 * it was latent rather than harmful. It stops being latent the moment anything
 * routes on caller identity, which is exactly what mode 2 above does. Recorded
 * as a defect in S2's instrument, not merely as an S3 design detail.
 *
 * ── the three tiers ────────────────────────────────────────────────────────
 *
 *   host     served from the host root, always. The CLI's own execution
 *            closure: its binary, ld-linux and its shared objects, ~/.claude,
 *            the session scratch dir, and the specific /etc files the runtime
 *            needs. No remote consult -- a remote file must never surface
 *            inside a pinned prefix.
 *   project  served from the remote root, NO FALLBACK. A fallback here would
 *            surface a host file inside the project tree, which is the exact
 *            incoherence this architecture exists to remove.
 *   default  remote first, host fallback, every fallback LOGGED. This is what
 *            makes Read('/etc/nginx.conf') and Write('/tmp/x') reach the remote.
 *   hide     ENOENT, and suppressed from the parent's readdir. Not a tier of
 *            the architecture: a rig necessity, see the recursion note below.
 *
 * Longest prefix wins, so /tmp (default) < /tmp/app (project) <
 * /tmp/claude-1000 (host) all resolve differently under one parent.
 *
 * The tier table is DATA, loaded from $FUSE_S3_PINS, not code -- so the pin
 * list the spike derives is an artefact that can be printed verbatim into the
 * results doc and diffed between runs.
 *
 * ── what /proc, /sys and /dev are, and are not ─────────────────────────────
 *
 * They are NOT tiers here and must never become tiers. S1 §7.1 measured why: a
 * passthrough serving /proc/self/... answers with the DAEMON's identity, so
 * /proc/self/exe -- which is how a bun single-file executable finds its own
 * embedded payload -- returns the daemon. They are real bind mounts layered
 * OVER this filesystem by the orchestrator script.
 *
 * ── readdir is a first-class policy, not an afterthought ───────────────────
 *
 * Defining open() but not enumeration is the same defect as the two-spellings
 * tell it is meant to cure. If readdir('/tmp') listed only the remote while
 * open('/tmp/host-only') fell back and succeeded, then `ls` and `cat` would
 * disagree about whether a file exists -- one path, two answers, from a single
 * caller.
 *
 * Since the host fallback is permanent by requirement, enumeration is made to
 * match it rather than the reverse: the default tier's readdir MERGES both
 * listings and dedupes with the remote winning. Each child entry is then
 * resolved to its OWN tier, so a pinned subdirectory of a default-tier parent
 * is listed from the host and a project subdirectory from the remote. The cost
 * is two getdents per directory plus a dedupe set per listing, landing straight
 * on the metadata path S1 measured at 5-10x host speed.
 *
 * ── self-recursion guard ───────────────────────────────────────────────────
 *
 * S1 §7.4 flagged it; this implements it. A caller in the daemon's own thread
 * group must never be served through the remote path, or the daemon blocks on a
 * request only it can answer and the mount deadlocks. Two S1 measurements
 * constrain the key:
 *
 *   - in_header.pid is the TID, not the TGID (S1 §6 Q1: 983 of 14 677 ops had
 *     pid != tgid). So Tgid is resolved from /proc/<pid>/status.
 *   - comm and uid are unusable as keys (S1 §6 Q3: one process reported ten
 *     comms over its life; 15 processes changed uid mid-life).
 *
 * The guard is the ONLY caller-based routing here, and that is a decision, not
 * an omission. Ancestry -- the only key that could describe "the CLI and its
 * children" -- is unknowable exactly when it matters: S1 §6 Q2 caught the first
 * read of claude.exe by the CLI's own tid logged comm=turn.sh, i.e. at the
 * instant the binary is paged in the process has not yet become the CLI; and a
 * grandchild whose parent has exited is reparented and its ancestry is gone.
 * The Bash tool's real work sits two generations down (S1 §6 Q3), so a
 * correct rule would need an ancestry walk -- a /proc read per link, per op,
 * on a path that saw 14 677 ops in a two-minute run.
 *
 * $FUSE_S3_NOGUARD disables it. That exists so the guard can be MEASURED by
 * deadlocking without it, rather than asserted.
 *
 * ── carried from S1, unchanged ─────────────────────────────────────────────
 *
 * Per-request setfsuid/setfsgid is mandatory, not a tuning knob: S1 §7.2
 * measured that without it the CLI's own Bash tool fails EACCES, because its
 * scratch directory gets created root-owned. Known limit, carried:
 * supplementary groups are NOT switched (setgroups(2) is per-process, not
 * per-thread), so a caller whose access depends on one can be wrongly denied by
 * the daemon-side check. default_permissions means the kernel has already
 * checked the caller's full credentials first, so this is a second gate rather
 * than the only one. It is not equivalent.
 *
 * The trace and the fallback log record PATHS ONLY, never content, so a
 * credential path may appear in them and a credential never does.
 *
 * ── environment ────────────────────────────────────────────────────────────
 *
 *   FUSE_S3_HOST_ROOT    host tier root            (default "/")
 *   FUSE_S3_REMOTE       fake-remote root          (required)
 *   FUSE_S3_PINS         tier table file           (required)
 *   FUSE_S3_MNT          mountpoint, hidden implicitly (recursion guard)
 *   FUSE_S3_TRACE        every path the kernel asks about, with caller identity
 *   FUSE_S3_TRACE_READS  also trace read/write (a 215 MB binary makes this loud)
 *   FUSE_S3_FALLBACK     the fallback log -- the instrument the pin list is
 *                        derived from, and the thing that must be empty by the
 *                        end
 *   FUSE_S3_KEEPCACHE    set cfg->kernel_cache
 *   FUSE_S3_NOGUARD      disable the self-recursion guard (cycle D only)
 *   FUSE_S3_ROUTE        path | marked | marked-strict   (default: path)
 *   FUSE_S3_MARK_PATH    the path whose resolution marks a TGID as CLAUDE
 *   FUSE_S3_MARK_VALIDATE cached | always                (default: cached)
 *   FUSE_S3_IDSTATS      write identity/validation counters here on exit
 *   FUSE_S3_NO_PCACHE_VALIDATE  restore S2's unvalidated pid cache, to measure
 *                        what the validation costs and what it prevents
 */
#define FUSE_USE_VERSION 31
#define _GNU_SOURCE

#include <fuse.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <dirent.h>
#include <pthread.h>
#include <limits.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/xattr.h>
#include <sys/time.h>
#include <sys/fsuid.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

/* ── tier table ─────────────────────────────────────────────────────────── */

/*
 * S2 PHASE A APPENDS T_BIND AND T_FAIL, AND APPENDS THEM DELIBERATELY.
 *
 * cc's pins file now carries the kinds `bind` and `fail`
 * (src/systems/fuse/tierTable.ts), and pins_load below rejects any kind it does
 * not know -- so without these two members the daemon exits before mounting and
 * every launch dies. That is the whole reason this edit exists: the SCHEMA, not
 * the routing.
 *
 * T_DEFAULT STAYS AT INDEX 0. Moving T_FAIL there -- which is what makes an
 * unmatched path fail-closed instead of remote-first -- is S2's port (H3/H5),
 * reviewed together with the route() change that gives it meaning. Until then
 * neither new member has a route() case, so both take the `default:` arm; see
 * PROVENANCE.md for the one behaviour window that follows and what closes it.
 */
enum tier { T_DEFAULT = 0, T_HOST, T_PROJECT, T_HIDE, T_BIND, T_FAIL };

static const char *tier_name(enum tier t)
{
	switch (t) {
	case T_HOST:    return "host";
	case T_PROJECT: return "project";
	case T_HIDE:    return "hide";
	case T_BIND:    return "bind";
	case T_FAIL:    return "fail";
	default:        return "default";
	}
}

struct pin {
	enum tier tier;
	char   prefix[PATH_MAX];
	size_t len;
};

#define MAX_PINS 512
static struct pin pins[MAX_PINS];
static size_t     npins = 0;

static int   host_fd = -1, remote_fd = -1;
static char  host_root[PATH_MAX]   = "/";
static char  remote_root[PATH_MAX] = "";
static pid_t self_tgid = 0;
static int   guard_enabled = 1;
static int   keep_cache    = 0;

static void pin_add(enum tier t, const char *prefix)
{
	struct pin *p;
	size_t n;

	if (npins >= MAX_PINS) {
		fprintf(stderr, "fuse-union-s3: too many pins (max %d)\n", MAX_PINS);
		exit(1);
	}
	p = &pins[npins++];
	p->tier = t;
	snprintf(p->prefix, sizeof(p->prefix), "%s", prefix);
	n = strlen(p->prefix);
	while (n > 1 && p->prefix[n - 1] == '/')
		p->prefix[--n] = '\0';
	p->len = n;
}

/*
 * Longest prefix wins. A prefix matches a path when the path IS it or lies
 * under it at a component boundary -- "/tmp/apple" must not match the pin
 * "/tmp/app", which a bare strncmp would happily do.
 */
static enum tier tier_of(const char *path)
{
	enum tier best_t = T_DEFAULT;
	size_t    best   = 0;
	size_t    i;

	for (i = 0; i < npins; i++) {
		const struct pin *p = &pins[i];
		if (p->len <= best)
			continue;
		if (strncmp(path, p->prefix, p->len) != 0)
			continue;
		if (p->len == 1 && p->prefix[0] == '/') {
			best = p->len; best_t = p->tier; continue;
		}
		if (path[p->len] != '\0' && path[p->len] != '/')
			continue;
		best   = p->len;
		best_t = p->tier;
	}
	return best_t;
}

static void pins_load(const char *file)
{
	FILE *f = fopen(file, "r");
	char  line[PATH_MAX + 64];

	if (!f) {
		fprintf(stderr, "fuse-union-s3: pins %s: %s\n", file, strerror(errno));
		exit(1);
	}
	while (fgets(line, sizeof(line), f)) {
		char *kind, *prefix, *nl;
		if ((nl = strchr(line, '\n')))
			*nl = '\0';
		kind = line + strspn(line, " \t");
		if (*kind == '\0' || *kind == '#')
			continue;
		prefix = kind + strcspn(kind, " \t");
		if (*prefix == '\0') {
			fprintf(stderr, "fuse-union-s3: pins: no path on line '%s'\n", line);
			exit(1);
		}
		*prefix++ = '\0';
		prefix += strspn(prefix, " \t");
		if (*prefix != '/') {
			fprintf(stderr, "fuse-union-s3: pins: not absolute: '%s'\n", prefix);
			exit(1);
		}
		if      (strcmp(kind, "host")    == 0) pin_add(T_HOST,    prefix);
		else if (strcmp(kind, "project") == 0) pin_add(T_PROJECT, prefix);
		else if (strcmp(kind, "hide")    == 0) pin_add(T_HIDE,    prefix);
		else if (strcmp(kind, "bind")    == 0) pin_add(T_BIND,    prefix);
		else if (strcmp(kind, "fail")    == 0) pin_add(T_FAIL,    prefix);
		else {
			fprintf(stderr, "fuse-union-s3: pins: unknown kind '%s'\n", kind);
			exit(1);
		}
	}
	fclose(f);
}

/* ── caller identity ────────────────────────────────────────────────────── */
/*
 * pid -> tgid, cached; a thread's tgid is fixed for its life. comm is NOT
 * cached and never will be: S1 §8.2 defect 2 cached it and every request from
 * the CLI came back labelled comm=bash, because the pid was first seen as the
 * shell that later exec'd into the CLI. comm changes on exec.
 */
#define PCACHE_SLOTS 8192
struct pent {
	pid_t         pid, tgid, ppid;
	unsigned long long start;   /* /proc/<pid>/stat field 22 */
	char          exe[192];     /* resolved once, per pid */
	char          cmd[192];     /* full cmdline, NULs -> spaces */
};
static struct pent     pcache[PCACHE_SLOTS];
static pthread_mutex_t pcache_mu = PTHREAD_MUTEX_INITIALIZER;
static int             pcache_validate = 0;  /* 1 = revalidate identity on hit */

/* counters, written to $FUSE_S3_IDSTATS on exit -- the cost of soundness */
static unsigned long long n_ops = 0, n_pcache_fill = 0, n_pcache_hit = 0,
			  n_stat_reads = 0, n_reuse_caught = 0;
static pthread_mutex_t    stat_mu = PTHREAD_MUTEX_INITIALIZER;

/*
 * Field 22 of /proc/<pid>/stat is the process start time in clock ticks. It is
 * the only cheap thing that distinguishes a recycled pid from its predecessor.
 * Parsing must start AFTER the comm field, which is parenthesised and may
 * itself contain spaces and ')' -- so scan to the LAST ')' rather than the
 * first, which is the classic way this parse goes wrong.
 */
static unsigned long long read_starttime(pid_t pid)
{
	char buf[64], line[1024], *p;
	unsigned long long st = 0;
	int f;
	ssize_t n;
	int field;

	pthread_mutex_lock(&stat_mu);
	n_stat_reads++;
	pthread_mutex_unlock(&stat_mu);

	snprintf(buf, sizeof(buf), "/proc/%d/stat", (int)pid);
	if ((f = open(buf, O_RDONLY)) == -1)
		return 0;
	n = read(f, line, sizeof(line) - 1);
	close(f);
	if (n <= 0)
		return 0;
	line[n] = '\0';
	if (!(p = strrchr(line, ')')))
		return 0;
	p++;                            /* now at the space before field 3 */
	for (field = 3; field <= 22; field++) {
		while (*p == ' ')
			p++;
		if (!*p)
			return 0;
		if (field == 22) {
			st = strtoull(p, NULL, 10);
			break;
		}
		while (*p && *p != ' ')
			p++;
	}
	return st;
}

static void read_exe(pid_t pid, char *out, size_t n)
{
	char buf[64];
	ssize_t r;

	snprintf(buf, sizeof(buf), "/proc/%d/exe", (int)pid);
	if ((r = readlink(buf, out, n - 1)) > 0) {
		out[r] = '\0';
		return;
	}
	/*
	 * /proc/<tgid>/exe is rendered by d_path against the READER's root. The
	 * daemon lives outside the chroot the callers live in, so the link can
	 * come back unreachable; the trace records "<unreadable>" rather than
	 * silently substituting the cmdline, because a column that means two
	 * different things in one file is worse than a gap.
	 */
	snprintf(out, n, "<unreadable>");
}

/*
 * THE COLUMN THAT ACTUALLY ATTRIBUTES AN OP. exe is the INTERPRETER for
 * anything script-shaped: a PreToolUse hook and the Bash forwarder are both
 * /bin/bash, and telling them apart is the entire containment question. The
 * kernel builds argv for a shebang script as [interpreter, script, args...],
 * so the script's own path is in the cmdline and nowhere else.
 */
static void read_cmdline(pid_t pid, char *out, size_t n)
{
	char buf[64];
	int f;
	ssize_t k, i;

	snprintf(out, n, "<gone>");
	snprintf(buf, sizeof(buf), "/proc/%d/cmdline", (int)pid);
	if ((f = open(buf, O_RDONLY)) == -1)
		return;
	k = read(f, out, n - 1);
	close(f);
	if (k <= 0) {
		snprintf(out, n, "<gone>");
		return;
	}
	out[k] = '\0';
	/*
	 * NULs become spaces -- and so does EVERY other control character. A
	 * `bash -c` cmdline carries the whole script, newlines included, and an
	 * embedded newline splits one trace row into many: the first version of
	 * this instrument produced 1662 unparsable rows out of ~3000 for exactly
	 * that reason, and the analysis silently dropped them.
	 */
	for (i = 0; i < k; i++)
		if ((unsigned char)out[i] < 0x20 || (unsigned char)out[i] == 0x7f)
			out[i] = ' ';
	while (k > 0 && out[k - 1] == ' ')
		out[--k] = '\0';
}

/*
 * Resolve TID -> (TGID, PPID, starttime, exe). The cache is S2's, with the
 * starttime and exe added. S2's had NO validation at all and never evicted; a
 * recycled pid returned its predecessor's tgid for the life of the daemon.
 * Here the entry carries the starttime it was filled with, so a caller that
 * needs soundness can compare against a fresh read -- see mark_of().
 */
static void resolve_ids(pid_t pid, pid_t *tgid_out, pid_t *ppid_out,
			unsigned long long *start_out, const char **exe_out,
			const char **cmd_out)
{
	size_t slot = ((size_t)pid * 2654435761u) % PCACHE_SLOTS;
	pid_t tgid = -1, ppid = -1;
	unsigned long long start = 0;
	const char *exe = "<gone>", *cmd = "<gone>";
	size_t i;

	pthread_mutex_lock(&pcache_mu);
	for (i = 0; i < 64; i++) {
		struct pent *e = &pcache[(slot + i) % PCACHE_SLOTS];
		if (e->pid == pid) {
			/*
			 * THE DEFECT THIS FIXES, DEMONSTRATED BY ITS ABSENCE.
			 * S2's cache is keyed on pid, never evicts and never
			 * validates, so the first process to occupy a pid owns
			 * that slot's identity for the life of the daemon. In
			 * S2 that could only mis-fire the self-recursion guard,
			 * which fails safe. Here it corrupts ATTRIBUTION: the
			 * first S3 analysis lost the MCP server entirely and
			 * charged its ops to the Bash forwarder, because the
			 * forwarder had held that pid earlier in the turn.
			 * Re-reading field 22 on hit is what makes the trace's
			 * caller columns mean what they say.
			 */
			if (pcache_validate) {
				unsigned long long now = read_starttime(pid);
				if (now != e->start) {
					pthread_mutex_lock(&stat_mu);
					n_reuse_caught++;
					pthread_mutex_unlock(&stat_mu);
					e->pid = 0;   /* refill below */
					i--;
					continue;
				}
			}
			/*
			 * exec(2) REPLACES the cmdline and the exe link while
			 * leaving pid, tgid and start time untouched -- so no
			 * amount of starttime validation can notice it, and an
			 * identity cached before the exec keeps the identity of
			 * the program that is no longer running. The first S3
			 * analysis lost the MCP server to exactly this: its
			 * slot was filled while it was still the /bin/sh that
			 * had not yet exec'd python3. S2 §9.1 recorded that
			 * comm changes on exec; cmdline and exe do too.
			 */
			if (pcache_validate) {
				read_exe(e->tgid > 0 ? e->tgid : pid, e->exe, sizeof(e->exe));
				read_cmdline(e->tgid > 0 ? e->tgid : pid, e->cmd, sizeof(e->cmd));
			}
			tgid = e->tgid; ppid = e->ppid;
			start = e->start; exe = e->exe; cmd = e->cmd;
			pthread_mutex_lock(&stat_mu);
			n_pcache_hit++;
			pthread_mutex_unlock(&stat_mu);
			break;
		}
		if (e->pid == 0) {
			char buf[64];
			FILE *f;

			e->pid = pid; e->tgid = -1; e->ppid = -1;
			e->start = 0; e->exe[0] = '\0';
			snprintf(buf, sizeof(buf), "/proc/%d/status", (int)pid);
			if ((f = fopen(buf, "r")) != NULL) {
				char line[256];
				while (fgets(line, sizeof(line), f)) {
					if (strncmp(line, "Tgid:", 5) == 0)
						e->tgid = (pid_t)atoi(line + 5);
					else if (strncmp(line, "PPid:", 5) == 0) {
						e->ppid = (pid_t)atoi(line + 5);
						break;
					}
				}
				fclose(f);
			}
			e->start = read_starttime(pid);
			read_exe(e->tgid > 0 ? e->tgid : pid, e->exe, sizeof(e->exe));
			read_cmdline(e->tgid > 0 ? e->tgid : pid, e->cmd, sizeof(e->cmd));
			tgid = e->tgid; ppid = e->ppid;
			start = e->start; exe = e->exe; cmd = e->cmd;
			pthread_mutex_lock(&stat_mu);
			n_pcache_fill++;
			pthread_mutex_unlock(&stat_mu);
			break;
		}
	}
	pthread_mutex_unlock(&pcache_mu);
	*tgid_out  = tgid;
	*ppid_out  = ppid;
	if (start_out) *start_out = start;
	if (exe_out)   *exe_out   = exe;
	if (cmd_out)   *cmd_out   = cmd;
}

static void read_comm(pid_t pid, char *out, size_t n)
{
	char buf[64];
	FILE *f;

	snprintf(out, n, "<gone>");
	snprintf(buf, sizeof(buf), "/proc/%d/comm", (int)pid);
	if ((f = fopen(buf, "r")) != NULL) {
		if (fgets(out, n, f)) {
			char *nl = strchr(out, '\n');
			if (nl) *nl = '\0';
		}
		fclose(f);
	}
}

/*
 * THE self-recursion guard. Not a routing policy -- a liveness precondition.
 * It is the minimum possible key (one tgid), needs no ancestry walk, and fails
 * safe: an over-broad guard serves the host, which is the default tier's
 * fallback anyway.
 */
static int caller_is_self(void)
{
	const struct fuse_context *c;
	pid_t tgid, ppid;

	if (!guard_enabled)
		return 0;
	c = fuse_get_context();
	if ((pid_t)c->pid == self_tgid)
		return 1;
	resolve_ids((pid_t)c->pid, &tgid, &ppid, NULL, NULL, NULL);
	return tgid == self_tgid;
}

/* ── the CLAUDE mark ────────────────────────────────────────────────────── */
/*
 * A TGID is marked the first time it RESOLVES $FUSE_S3_MARK_PATH -- the CLI's
 * real binary. S2 §9.1 measured that this is NOT the process's first op: the
 * marked TGID is the shell that later execs into the CLI, and it does real work
 * first. That window is a property of the launcher, and it is why the mark
 * cannot be assumed available early.
 *
 * The entry carries the TGID's start time, so a recycled pid cannot inherit the
 * mark. $FUSE_S3_MARK_VALIDATE=always re-reads field 22 on every check;
 * =cached trusts the cached value and is the unsound-but-fast arm.
 */
#define MARK_SLOTS 4096
struct mark { pid_t tgid; unsigned long long start; };
static struct mark      marks[MARK_SLOTS];
static size_t           nmarks = 0;
static pthread_mutex_t  mark_mu = PTHREAD_MUTEX_INITIALIZER;
static const char      *mark_path     = NULL;
static int              mark_validate = 0;   /* 1 = always re-read field 22 */

enum route_mode { R_PATH = 0, R_MARKED, R_MARKED_STRICT };
static enum route_mode route_mode = R_PATH;

static void mark_add(pid_t tgid, unsigned long long start)
{
	size_t i;

	if (tgid <= 0)
		return;
	pthread_mutex_lock(&mark_mu);
	for (i = 0; i < nmarks; i++)
		if (marks[i].tgid == tgid) {
			marks[i].start = start;   /* re-mark after reuse */
			pthread_mutex_unlock(&mark_mu);
			return;
		}
	if (nmarks < MARK_SLOTS) {
		marks[nmarks].tgid  = tgid;
		marks[nmarks].start = start;
		nmarks++;
	}
	pthread_mutex_unlock(&mark_mu);
}

/* 1 = this caller's thread group is marked CLAUDE. */
static int mark_of(pid_t tgid, unsigned long long cached_start)
{
	size_t i;
	int hit = 0;
	unsigned long long want = 0;

	if (tgid <= 0)
		return 0;
	pthread_mutex_lock(&mark_mu);
	for (i = 0; i < nmarks; i++)
		if (marks[i].tgid == tgid) {
			hit  = 1;
			want = marks[i].start;
			break;
		}
	pthread_mutex_unlock(&mark_mu);
	if (!hit)
		return 0;
	if (!mark_validate)
		return 1;
	/*
	 * THE PID-REUSE GATE. A live process's start time never changes, so a
	 * mismatch means this tgid is NOT the process that was marked -- the pid
	 * was recycled. Drop the mark rather than answer with it.
	 */
	{
		unsigned long long now = read_starttime(tgid);
		if (now != want) {
			pthread_mutex_lock(&mark_mu);
			for (i = 0; i < nmarks; i++)
				if (marks[i].tgid == tgid) {
					marks[i] = marks[nmarks - 1];
					nmarks--;
					break;
				}
			pthread_mutex_unlock(&mark_mu);
			pthread_mutex_lock(&stat_mu);
			n_reuse_caught++;
			pthread_mutex_unlock(&stat_mu);
			return 0;
		}
	}
	(void)cached_start;
	return 1;
}

/* Resolve the calling thread to (tgid, exe, mark) in one place. */
static int caller_identity(pid_t *tgid_out, const char **exe_out)
{
	const struct fuse_context *c = fuse_get_context();
	pid_t tgid, ppid;
	unsigned long long start;
	const char *exe;

	resolve_ids((pid_t)c->pid, &tgid, &ppid, &start, &exe, NULL);
	if (tgid_out) *tgid_out = tgid;
	if (exe_out)  *exe_out  = exe;
	return mark_of(tgid, start);
}

/* Called on every routed path: the marking EVENT. */
static void mark_maybe(const char *path)
{
	const struct fuse_context *c;
	pid_t tgid, ppid;
	unsigned long long start;

	if (!mark_path || strcmp(path, mark_path) != 0)
		return;
	c = fuse_get_context();
	resolve_ids((pid_t)c->pid, &tgid, &ppid, &start, NULL, NULL);
	mark_add(tgid, start);
}

/* ── trace ──────────────────────────────────────────────────────────────── */

static FILE           *trace_fp    = NULL;
static int             trace_reads = 0;
static pthread_mutex_t trace_mu    = PTHREAD_MUTEX_INITIALIZER;

static void tr(const char *op, const char *path, const char *tier, int fell_back)
{
	const struct fuse_context *ctx;
	char comm[24];
	const char *exe, *cmd;
	pid_t tgid, ppid;
	unsigned long long start;
	int marked;

	pthread_mutex_lock(&stat_mu);
	n_ops++;
	pthread_mutex_unlock(&stat_mu);

	if (!trace_fp)
		return;
	ctx = fuse_get_context();
	resolve_ids((pid_t)ctx->pid, &tgid, &ppid, &start, &exe, &cmd);
	read_comm((pid_t)ctx->pid, comm, sizeof(comm));
	marked = mark_of(tgid, start);

	pthread_mutex_lock(&trace_mu);
	fprintf(trace_fp,
		"%s\t%s\ttier=%s fb=%d pid=%d uid=%d gid=%d tgid=%d ppid=%d "
		"comm=%s mark=%d exe=%s cmd=%s\n",
		op, path, tier, fell_back, (int)ctx->pid, (int)ctx->uid,
		(int)ctx->gid, (int)tgid, (int)ppid, comm, marked, exe, cmd);
	pthread_mutex_unlock(&trace_mu);
}

/* counters, dumped on exit so the cost of MARK_VALIDATE=always is a number */
static void idstats_dump(void)
{
	const char *f = getenv("FUSE_S3_IDSTATS");
	FILE *o;

	if (!f || !(o = fopen(f, "a")))
		return;
	fprintf(o, "route=%s validate=%s ops=%llu pcache_fill=%llu "
		   "pcache_hit=%llu stat_reads=%llu reuse_caught=%llu marks=%zu "
		   "pcache_validate=%d\n",
		route_mode == R_PATH ? "path" :
		route_mode == R_MARKED ? "marked" : "marked-strict",
		mark_validate ? "always" : "cached",
		n_ops, n_pcache_fill, n_pcache_hit, n_stat_reads,
		n_reuse_caught, nmarks, pcache_validate);
	fclose(o);
}

/* ── fallback log ───────────────────────────────────────────────────────── */
/*
 * The instrument the pin list is derived from, and the thing that must be empty
 * by the end. Deduplicated on path+reason so a 215 MB demand-paged binary
 * cannot bury the one line that matters. Paths only, never content.
 */
static FILE           *fb_fp = NULL;
static pthread_mutex_t fb_mu = PTHREAD_MUTEX_INITIALIZER;

#define FBSET_SLOTS 65536
static char *fbset[FBSET_SLOTS];
static size_t fbset_n = 0;

static unsigned long strhash(const char *s)
{
	unsigned long h = 5381;
	while (*s) h = h * 33 + (unsigned char)*s++;
	return h;
}

/* caller holds fb_mu */
static int fb_seen(const char *key)
{
	size_t slot, i;

	if (fbset_n >= FBSET_SLOTS / 2)
		return 0;                       /* full: stop deduping, keep logging */
	slot = strhash(key) % FBSET_SLOTS;
	for (i = 0; i < FBSET_SLOTS; i++) {
		char **e = &fbset[(slot + i) % FBSET_SLOTS];
		if (!*e) { *e = strdup(key); fbset_n++; return 0; }
		if (strcmp(*e, key) == 0) return 1;
	}
	return 0;
}

static void fb_log(const char *op, const char *path, const char *reason)
{
	char key[PATH_MAX + 64];

	if (!fb_fp)
		return;
	snprintf(key, sizeof(key), "%s\t%s", path, reason);
	pthread_mutex_lock(&fb_mu);
	if (!fb_seen(key))
		fprintf(fb_fp, "%s\t%s\t%s\n", op, path, reason);
	pthread_mutex_unlock(&fb_mu);
}

/* ── per-request credentials (verbatim from S1; see the header) ─────────── */

static inline void cred_enter(void)
{
	const struct fuse_context *c = fuse_get_context();
	setfsgid(c->gid);
	setfsuid(c->uid);
}

static inline void cred_leave(void)
{
	setfsuid(0);
	setfsgid(0);
}

/* ── routing ────────────────────────────────────────────────────────────── */

static const char *rel(const char *path)
{
	if (path[0] == '/' && path[1] == '\0')
		return ".";
	return path + 1;
}

/*
 * Existence probes run as the DAEMON, not as the caller, and that is
 * deliberate: routing is a question about WHERE A FILE IS, not about whether
 * this caller may see it. Access is enforced twice over regardless -- by
 * default_permissions in the kernel before we are asked, and by cred_enter()
 * around the real syscall.
 */
static int exists_in(int dirfd, const char *rp)
{
	struct stat st;
	return fstatat(dirfd, rp, &st, AT_SYMLINK_NOFOLLOW) == 0;
}

static int parent_exists_in(int dirfd, const char *rp)
{
	char buf[PATH_MAX];
	char *slash;

	snprintf(buf, sizeof(buf), "%s", rp);
	slash = strrchr(buf, '/');
	if (!slash)
		return 1;               /* parent is the root itself */
	*slash = '\0';
	return exists_in(dirfd, buf[0] ? buf : ".");
}

struct route {
	enum tier   tier;
	int         fd;
	const char *rp;
	int         fallback;
	const char *reason;
};

/*
 * fd -> the tier its open() routed to, so read/write can be traced with the
 * tier that actually backs them instead of a placeholder. Measurement only:
 * nothing routes on this. It exists because in S3 every read on a remote-tier
 * fd is a round trip, so a partition of ops by tier that excluded reads would
 * understate the thing it is meant to size.
 *
 * A plain array indexed by fd, one byte, written once by the open that
 * produced the fd and read by that fd's own ops. No lock: the kernel does not
 * hand the same fd number to two live handles.
 */
#define FDTIER_SLOTS 65536
static unsigned char fd_tier[FDTIER_SLOTS];
static unsigned char fd_fb[FDTIER_SLOTS];

static void fd_tier_set(int fd, enum tier t, int fb)
{
	if (fd >= 0 && fd < FDTIER_SLOTS) { fd_tier[fd] = (unsigned char)t; fd_fb[fd] = (unsigned char)fb; }
}

static const char *fd_tier_name(uint64_t fh)
{
	int fd = (int)fh;
	return (fd >= 0 && fd < FDTIER_SLOTS) ? tier_name((enum tier)fd_tier[fd]) : "fh";
}

static int fd_tier_fb(uint64_t fh)
{
	int fd = (int)fh;
	return (fd >= 0 && fd < FDTIER_SLOTS) ? fd_fb[fd] : 0;
}

/* for_create: route a path that does not exist yet by its PARENT, so create
 * lands in the same tier a later lookup of it would. */
static int route(const char *op, const char *path, int for_create, struct route *r)
{
	r->rp       = rel(path);
	r->fallback = 0;
	r->reason   = NULL;
	r->tier     = tier_of(path);

	/* THE MARKING EVENT, before tier dispatch: reading the CLI's own binary
	 * is a host-tier op, so a mark set after dispatch would never fire. */
	mark_maybe(path);

	switch (r->tier) {
	case T_HIDE:
		return -ENOENT;

	case T_HOST:
		r->fd = host_fd;
		return 0;

	case T_PROJECT:
		if (caller_is_self()) {
			r->fd = host_fd; r->fallback = 1; r->reason = "self-recursion";
			fb_log(op, path, r->reason);
			return 0;
		}
		/*
		 * THE COHERENCE ARM. Under marked-strict the project tier is
		 * remote-only AND marked-only, so an unmarked caller gets ENOENT
		 * rather than the remote copy. There is no third answer available:
		 * the project tier has no host side to fall back to by design
		 * (S2 §2.5), so "deny the remote" can only mean "deny".
		 */
		if (route_mode == R_MARKED_STRICT && !caller_identity(NULL, NULL)) {
			fb_log(op, path, "unmarked-project-denied");
			return -ENOENT;
		}
		r->fd = remote_fd;      /* no fallback, by design */
		return 0;

	default:
		if (caller_is_self()) {
			r->fd = host_fd; r->fallback = 1; r->reason = "self-recursion";
			fb_log(op, path, r->reason);
			return 0;
		}
		/*
		 * THE INVERTED DEFAULT. Nothing is remote unless the caller is
		 * marked CLAUDE. This fails safe in the direction that matters:
		 * an unmarked process -- a hook, an MCP server, the Bash
		 * forwarder -- can never mutate the user's remote box, because it
		 * is served the host for every default-tier path. The cost is
		 * that the CLI's own pre-mark window (S2 §9.1) is served the host
		 * too, and that anything the CLI legitimately delegates to a
		 * child sees a different filesystem from its parent.
		 */
		if (route_mode != R_PATH && !caller_identity(NULL, NULL)) {
			r->fd = host_fd;
			r->fallback = 1;
			r->reason = "unmarked-caller";
			fb_log(op, path, r->reason);
			return 0;
		}
		if (exists_in(remote_fd, r->rp)) {
			r->fd = remote_fd;
			return 0;
		}
		if (for_create && parent_exists_in(remote_fd, r->rp)) {
			r->fd = remote_fd;
			return 0;
		}
		r->fd = host_fd;
		/*
		 * A FALLBACK IS ONLY A FALLBACK IF THE HOST ACTUALLY HAS IT.
		 * Instrument defect, found by running this: the first version
		 * logged every default-tier miss, including paths that exist in
		 * NEITHER tier. Those are negative lookups -- every PATH search,
		 * every stat of a file about to be created -- and they are the
		 * commonest op there is, so the log filled with entries where
		 * nothing was served from anywhere and the acceptance criterion
		 * "the fallback log is empty" became unreachable for a reason
		 * that had nothing to do with tiering.
		 *
		 * Logging only when the host has the path makes an entry mean
		 * what the criterion says it means: THIS PATH WAS SERVED BY THE
		 * HOST INSTEAD OF THE REMOTE. Nothing is lost for deriving the
		 * pin list -- a path absent on both sides answers identically
		 * either way -- and the full trace still records every probe.
		 */
		if (for_create ? parent_exists_in(host_fd, r->rp)
		               : exists_in(host_fd, r->rp)) {
			r->fallback = 1;
			r->reason   = for_create ? "fallback-write" : "remote-enoent";
			fb_log(op, path, r->reason);
		}
		return 0;
	}
}

#define ROUTE(op, p, create)                            \
	struct route r;                                 \
	int rrc = route(op, p, create, &r);             \
	if (rrc)                                        \
		return rrc;                             \
	tr(op, p, tier_name(r.tier), r.fallback);       \
	const char *rp = r.rp;

/* ── name set, for the merged readdir ───────────────────────────────────── */

struct nameset { char **v; size_t cap, n; };

static int ns_init(struct nameset *s, size_t cap)
{
	s->cap = cap; s->n = 0;
	s->v = calloc(cap, sizeof(char *));
	return s->v ? 0 : -1;
}

static void ns_free(struct nameset *s)
{
	size_t i;
	for (i = 0; i < s->cap; i++) free(s->v[i]);
	free(s->v);
	s->v = NULL;
}

static int ns_grow(struct nameset *s);

/* 1 = newly added (emit it), 0 = already present (a duplicate: remote won) */
static int ns_add(struct nameset *s, const char *name)
{
	size_t slot, i;

	if (s->n * 2 >= s->cap && ns_grow(s) != 0)
		return 1;               /* out of memory: emit rather than drop */
	slot = strhash(name) & (s->cap - 1);
	for (i = 0; i < s->cap; i++) {
		char **e = &s->v[(slot + i) & (s->cap - 1)];
		if (!*e) { *e = strdup(name); s->n++; return 1; }
		if (strcmp(*e, name) == 0) return 0;
	}
	return 1;
}

static int ns_grow(struct nameset *s)
{
	struct nameset t;
	size_t i;

	if (ns_init(&t, s->cap * 2) != 0)
		return -1;
	for (i = 0; i < s->cap; i++)
		if (s->v[i]) ns_add(&t, s->v[i]);
	ns_free(s);
	*s = t;
	return 0;
}

/* ── operations ─────────────────────────────────────────────────────────── */

static void *pt_init(struct fuse_conn_info *conn, struct fuse_config *cfg)
{
	(void)conn;
	/* A union must not invent st_ino. Both roots here live on the same host
	 * filesystem, so their inode spaces cannot collide; a real remote tier
	 * could collide and S3 has to decide what to do about it. */
	cfg->use_ino = 1;
	cfg->kernel_cache = keep_cache;
	return NULL;
}

static int pt_getattr(const char *path, struct stat *st, struct fuse_file_info *fi)
{
	int rc;
	if (fi && fi->fh) {
		tr("getattr", path, "fh", 0);
		return fstat((int)fi->fh, st) == -1 ? -errno : 0;
	}
	{
		ROUTE("getattr", path, 0);
		cred_enter();
		rc = fstatat(r.fd, rp, st, AT_SYMLINK_NOFOLLOW);
		int e = errno;
		cred_leave();
		return rc == -1 ? -e : 0;
	}
}

static int pt_access(const char *path, int mask)
{
	ROUTE("access", path, 0);
	cred_enter();
	int rc = faccessat(r.fd, rp, mask, AT_EACCESS);
	int e = errno;
	cred_leave();
	return rc == -1 ? -e : 0;
}

static int pt_readlink(const char *path, char *buf, size_t size)
{
	ROUTE("readlink", path, 0);
	cred_enter();
	ssize_t n = readlinkat(r.fd, rp, buf, size - 1);
	int e = errno;
	cred_leave();
	if (n == -1) return -e;
	buf[n] = '\0';
	return 0;
}

/* ── readdir: the merge ─────────────────────────────────────────────────── */

struct dirhandle {
	DIR      *d[2];         /* 0 = remote, 1 = host */
	enum tier tier;
	int       merged;
	char      path[PATH_MAX];
};

static DIR *opendir_at(int dirfd, const char *rp)
{
	int fd = openat(dirfd, rp, O_RDONLY | O_DIRECTORY);
	DIR *d;
	if (fd == -1) return NULL;
	if (!(d = fdopendir(fd))) { int e = errno; close(fd); errno = e; }
	return d;
}

static int pt_opendir(const char *path, struct fuse_file_info *fi)
{
	ROUTE("opendir", path, 0);
	struct dirhandle *h;
	int self = r.reason && strcmp(r.reason, "self-recursion") == 0;
	int e;

	if (!(h = calloc(1, sizeof(*h))))
		return -ENOMEM;
	snprintf(h->path, sizeof(h->path), "%s", path);
	h->tier = r.tier;

	cred_enter();
	if (self) {
		h->d[1] = opendir_at(host_fd, rp);
	} else if (r.tier == T_HOST) {
		h->d[1] = opendir_at(host_fd, rp);
	} else if (r.tier == T_PROJECT) {
		h->d[0] = opendir_at(remote_fd, rp);
	} else {
		h->d[0] = opendir_at(remote_fd, rp);
		h->d[1] = opendir_at(host_fd, rp);
		h->merged = 1;
	}
	e = errno;
	cred_leave();

	if (!h->d[0] && !h->d[1]) {
		free(h);
		return -(e ? e : ENOENT);
	}
	/* A merged listing that reached only one side is still a fallback, and
	 * `ls` is exactly where a reader would notice the union is incomplete. */
	if (h->merged && !h->d[0] && h->d[1])
		fb_log("readdir", path, "remote-enoent");
	fi->fh = (uint64_t)(uintptr_t)h;
	return 0;
}

static int pt_readdir(const char *path, void *buf, fuse_fill_dir_t filler,
		      off_t off, struct fuse_file_info *fi,
		      enum fuse_readdir_flags flags)
{
	(void)off; (void)flags;
	struct dirhandle *h = (struct dirhandle *)(uintptr_t)fi->fh;
	struct nameset seen;
	int src;

	if (ns_init(&seen, 128) != 0)
		return -ENOMEM;

	/* remote first, so a name present in both is emitted from the remote */
	for (src = 0; src < 2; src++) {
		struct dirent *de;
		if (!h->d[src]) continue;
		rewinddir(h->d[src]);
		while ((de = readdir(h->d[src])) != NULL) {
			char  child[PATH_MAX];
			struct stat st;
			enum tier ct;

			if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) {
				if (!ns_add(&seen, de->d_name)) continue;
				goto emit;
			}
			snprintf(child, sizeof(child), "%s%s%s",
				 strcmp(path, "/") == 0 ? "" : path, "/", de->d_name);
			ct = tier_of(child);

			/* the mountpoint and the rig's own scaffolding. Without
			 * this the union lists its own backing store, and a
			 * dirent that cannot be stat'd is its own tell. */
			if (ct == T_HIDE)
				continue;

			if (h->merged) {
				/* each child is listed from the tier that OWNS
				 * it, not from the tier of its parent */
				if (src == 0 && ct == T_HOST)    continue;
				if (src == 1 && ct == T_PROJECT) continue;
			}
			if (!ns_add(&seen, de->d_name))
				continue;
emit:
			memset(&st, 0, sizeof(st));
			st.st_ino  = de->d_ino;
			st.st_mode = de->d_type << 12;
			if (filler(buf, de->d_name, &st, 0, 0))
				goto done;
		}
	}
done:
	ns_free(&seen);
	return 0;
}

static int pt_releasedir(const char *path, struct fuse_file_info *fi)
{
	struct dirhandle *h = (struct dirhandle *)(uintptr_t)fi->fh;
	(void)path;
	if (h->d[0]) closedir(h->d[0]);
	if (h->d[1]) closedir(h->d[1]);
	free(h);
	return 0;
}

/* ── mutations ──────────────────────────────────────────────────────────── */

static int pt_mkdir(const char *path, mode_t mode)
{
	ROUTE("mkdir", path, 1);
	cred_enter();
	int rc = mkdirat(r.fd, rp, mode);
	int e = errno;
	cred_leave();
	return rc == -1 ? -e : 0;
}

static int pt_mknod(const char *path, mode_t mode, dev_t rdev)
{
	ROUTE("mknod", path, 1);
	cred_enter();
	int rc = mknodat(r.fd, rp, mode, rdev);
	int e = errno;
	cred_leave();
	return rc == -1 ? -e : 0;
}

static int pt_unlink(const char *path)
{
	ROUTE("unlink", path, 0);
	if (r.fallback) fb_log("unlink", path, "fallback-write");
	cred_enter();
	int rc = unlinkat(r.fd, rp, 0);
	int e = errno;
	cred_leave();
	return rc == -1 ? -e : 0;
}

static int pt_rmdir(const char *path)
{
	ROUTE("rmdir", path, 0);
	if (r.fallback) fb_log("rmdir", path, "fallback-write");
	cred_enter();
	int rc = unlinkat(r.fd, rp, AT_REMOVEDIR);
	int e = errno;
	cred_leave();
	return rc == -1 ? -e : 0;
}

static int pt_symlink(const char *target, const char *path)
{
	ROUTE("symlink", path, 1);
	cred_enter();
	int rc = symlinkat(target, r.fd, rp);
	int e = errno;
	cred_leave();
	return rc == -1 ? -e : 0;
}

/*
 * CROSS-TIER RENAME IS -EXDEV, AND THAT IS AN ARCHITECTURE FINDING, NOT A
 * SHORTCUT. renameat2 cannot move a file between two backing stores. S1 §5.3
 * recorded the CLI doing a .claude.json.tmp.<pid>.<rand> write-and-rename in
 * $HOME, so a pin list that covers ~/.claude but not $HOME itself puts the
 * temp file in one tier and its rename target in another. S3 has to choose
 * between EXDEV, copy+unlink, or a pin boundary that cannot be straddled.
 */
static int pt_rename(const char *from, const char *to, unsigned int flags)
{
	struct route rf, rt;
	int rc;

	if ((rc = route("rename", from, 0, &rf))) return rc;
	if ((rc = route("rename", to,   1, &rt))) return rc;
	tr("rename", to, tier_name(rt.tier), rt.fallback);
	if (rf.fd != rt.fd) {
		fb_log("rename", to, "xdev-rename");
		return -EXDEV;
	}
	cred_enter();
	rc = renameat2(rf.fd, rf.rp, rt.fd, rt.rp, flags);
	int e = errno;
	cred_leave();
	return rc == -1 ? -e : 0;
}

static int pt_link(const char *from, const char *to)
{
	struct route rf, rt;
	int rc;

	if ((rc = route("link", from, 0, &rf))) return rc;
	if ((rc = route("link", to,   1, &rt))) return rc;
	tr("link", to, tier_name(rt.tier), rt.fallback);
	if (rf.fd != rt.fd) {
		fb_log("link", to, "xdev-rename");
		return -EXDEV;
	}
	cred_enter();
	rc = linkat(rf.fd, rf.rp, rt.fd, rt.rp, 0);
	int e = errno;
	cred_leave();
	return rc == -1 ? -e : 0;
}

static int pt_chmod(const char *path, mode_t mode, struct fuse_file_info *fi)
{
	if (fi && fi->fh) {
		tr("chmod", path, "fh", 0);
		return fchmod((int)fi->fh, mode) == -1 ? -errno : 0;
	}
	{
		ROUTE("chmod", path, 0);
		cred_enter();
		int rc = fchmodat(r.fd, rp, mode, 0);
		int e = errno;
		cred_leave();
		return rc == -1 ? -e : 0;
	}
}

static int pt_chown(const char *path, uid_t uid, gid_t gid, struct fuse_file_info *fi)
{
	if (fi && fi->fh) {
		tr("chown", path, "fh", 0);
		return fchown((int)fi->fh, uid, gid) == -1 ? -errno : 0;
	}
	{
		ROUTE("chown", path, 0);
		cred_enter();
		int rc = fchownat(r.fd, rp, uid, gid, AT_SYMLINK_NOFOLLOW);
		int e = errno;
		cred_leave();
		return rc == -1 ? -e : 0;
	}
}

static int pt_truncate(const char *path, off_t size, struct fuse_file_info *fi)
{
	if (fi && fi->fh) {
		tr("truncate", path, "fh", 0);
		return ftruncate((int)fi->fh, size) == -1 ? -errno : 0;
	}
	{
		ROUTE("truncate", path, 0);
		if (r.fallback) fb_log("truncate", path, "fallback-write");
		cred_enter();
		int fd = openat(r.fd, rp, O_WRONLY);
		int oe = errno;
		cred_leave();
		if (fd == -1) return -oe;
		int rc = ftruncate(fd, size);
		int e = errno;
		close(fd);
		return rc == -1 ? -e : 0;
	}
}

static int pt_utimens(const char *path, const struct timespec ts[2],
		      struct fuse_file_info *fi)
{
	if (fi && fi->fh) {
		tr("utimens", path, "fh", 0);
		return futimens((int)fi->fh, ts) == -1 ? -errno : 0;
	}
	{
		ROUTE("utimens", path, 0);
		cred_enter();
		int rc = utimensat(r.fd, rp, ts, AT_SYMLINK_NOFOLLOW);
		int e = errno;
		cred_leave();
		return rc == -1 ? -e : 0;
	}
}

static int pt_create(const char *path, mode_t mode, struct fuse_file_info *fi)
{
	ROUTE("create", path, 1);
	cred_enter();
	int fd = openat(r.fd, rp, fi->flags | O_CREAT, mode);
	int e = errno;
	cred_leave();
	if (fd == -1) return -e;
	fd_tier_set(fd, r.tier, r.fallback);
	fi->fh = fd;
	return 0;
}

static int pt_open(const char *path, struct fuse_file_info *fi)
{
	ROUTE("open", path, 0);
	/* A write to a file that exists only on the host lands on the host. That
	 * is the "wrong but working" degradation the fallback is FOR, and this
	 * is the line that makes it visible instead of silent. */
	if (r.fallback && (fi->flags & (O_WRONLY | O_RDWR)))
		fb_log("open", path, "fallback-write");
	cred_enter();
	int fd = openat(r.fd, rp, fi->flags);
	int e = errno;
	cred_leave();
	if (fd == -1) return -e;
	fd_tier_set(fd, r.tier, r.fallback);
	fi->fh = fd;
	return 0;
}

static int pt_read(const char *path, char *buf, size_t size, off_t off,
		   struct fuse_file_info *fi)
{
	ssize_t n;
	if (trace_reads) tr("read", path, fd_tier_name(fi->fh), fd_tier_fb(fi->fh));
	n = pread((int)fi->fh, buf, size, off);
	return n == -1 ? -errno : (int)n;
}

static int pt_write(const char *path, const char *buf, size_t size, off_t off,
		    struct fuse_file_info *fi)
{
	ssize_t n;
	if (trace_reads) tr("write", path, fd_tier_name(fi->fh), fd_tier_fb(fi->fh));
	n = pwrite((int)fi->fh, buf, size, off);
	return n == -1 ? -errno : (int)n;
}

static int pt_statfs(const char *path, struct statvfs *stbuf)
{
	ROUTE("statfs", path, 0);
	(void)rp;
	return fstatvfs(r.fd, stbuf) == -1 ? -errno : 0;
}

static int pt_flush(const char *path, struct fuse_file_info *fi)
{
	(void)path;
	int fd = dup((int)fi->fh);
	if (fd == -1) return -errno;
	return close(fd) == -1 ? -errno : 0;
}

static int pt_release(const char *path, struct fuse_file_info *fi)
{
	(void)path;
	close((int)fi->fh);
	return 0;
}

static int pt_fsync(const char *path, int datasync, struct fuse_file_info *fi)
{
	(void)path;
	int rc = datasync ? fdatasync((int)fi->fh) : fsync((int)fi->fh);
	return rc == -1 ? -errno : 0;
}

static int pt_fallocate(const char *path, int mode, off_t off, off_t len,
			struct fuse_file_info *fi)
{
	(void)path;
	return fallocate((int)fi->fh, mode, off, len) == -1 ? -errno : 0;
}

static off_t pt_lseek(const char *path, off_t off, int whence,
		      struct fuse_file_info *fi)
{
	(void)path;
	off_t rc = lseek((int)fi->fh, off, whence);
	return rc == -1 ? -errno : rc;
}

/* xattr: reported through the routed tier, so a caller that consults them sees
 * the real answer of the tier that owns the file rather than a synthetic
 * ENOTSUP -- and never the other tier's. */
static void abspath(const struct route *r, const char *path, char *out, size_t n)
{
	const char *root = (r->fd == remote_fd) ? remote_root : host_root;
	snprintf(out, n, "%s%s", strcmp(root, "/") == 0 ? "" : root, path);
}

static int pt_setxattr(const char *path, const char *name, const char *value,
		       size_t size, int flags)
{
	ROUTE("setxattr", path, 0);
	(void)rp;
	char abs[PATH_MAX];
	abspath(&r, path, abs, sizeof(abs));
	return lsetxattr(abs, name, value, size, flags) == -1 ? -errno : 0;
}

static int pt_getxattr(const char *path, const char *name, char *value, size_t size)
{
	ROUTE("getxattr", path, 0);
	(void)rp;
	char abs[PATH_MAX];
	abspath(&r, path, abs, sizeof(abs));
	ssize_t n = lgetxattr(abs, name, value, size);
	return n == -1 ? -errno : (int)n;
}

static int pt_listxattr(const char *path, char *list, size_t size)
{
	ROUTE("listxattr", path, 0);
	(void)rp;
	char abs[PATH_MAX];
	abspath(&r, path, abs, sizeof(abs));
	ssize_t n = llistxattr(abs, list, size);
	return n == -1 ? -errno : (int)n;
}

static int pt_removexattr(const char *path, const char *name)
{
	ROUTE("removexattr", path, 0);
	(void)rp;
	char abs[PATH_MAX];
	abspath(&r, path, abs, sizeof(abs));
	return lremovexattr(abs, name) == -1 ? -errno : 0;
}

static const struct fuse_operations pt_ops = {
	.init        = pt_init,
	.getattr     = pt_getattr,
	.access      = pt_access,
	.readlink    = pt_readlink,
	.opendir     = pt_opendir,
	.readdir     = pt_readdir,
	.releasedir  = pt_releasedir,
	.mkdir       = pt_mkdir,
	.mknod       = pt_mknod,
	.unlink      = pt_unlink,
	.rmdir       = pt_rmdir,
	.symlink     = pt_symlink,
	.rename      = pt_rename,
	.link        = pt_link,
	.chmod       = pt_chmod,
	.chown       = pt_chown,
	.truncate    = pt_truncate,
	.utimens     = pt_utimens,
	.create      = pt_create,
	.open        = pt_open,
	.read        = pt_read,
	.write       = pt_write,
	.statfs      = pt_statfs,
	.flush       = pt_flush,
	.release     = pt_release,
	.fsync       = pt_fsync,
	.fallocate   = pt_fallocate,
	.lseek       = pt_lseek,
	.setxattr    = pt_setxattr,
	.getxattr    = pt_getxattr,
	.listxattr   = pt_listxattr,
	.removexattr = pt_removexattr,
};

int main(int argc, char *argv[])
{
	const char *hr = getenv("FUSE_S3_HOST_ROOT") ?: "/";
	const char *rr = getenv("FUSE_S3_REMOTE");
	const char *pf = getenv("FUSE_S3_PINS");
	const char *tp = getenv("FUSE_S3_TRACE");
	const char *fp = getenv("FUSE_S3_FALLBACK");
	const char *mp = getenv("FUSE_S3_MNT");

	const char *rm = getenv("FUSE_S3_ROUTE");
	const char *mv = getenv("FUSE_S3_MARK_VALIDATE");

	keep_cache    = getenv("FUSE_S3_KEEPCACHE") != NULL;
	trace_reads   = getenv("FUSE_S3_TRACE_READS") != NULL;
	guard_enabled = getenv("FUSE_S3_NOGUARD") == NULL;
	self_tgid     = getpid();
	mark_path     = getenv("FUSE_S3_MARK_PATH");
	mark_validate = (mv && strcmp(mv, "always") == 0);
	/* Identity attribution is S3's deliverable, so this defaults ON and is
	 * disabled explicitly to measure what it costs and what it prevents. */
	pcache_validate = getenv("FUSE_S3_NO_PCACHE_VALIDATE") == NULL;

	if (!rm || strcmp(rm, "path") == 0)            route_mode = R_PATH;
	else if (strcmp(rm, "marked") == 0)            route_mode = R_MARKED;
	else if (strcmp(rm, "marked-strict") == 0)     route_mode = R_MARKED_STRICT;
	else {
		fprintf(stderr, "fuse-union-s3: REFUSED — FUSE_S3_ROUTE=%s is not "
				"one of path|marked|marked-strict\n", rm);
		return 1;
	}
	/* A routing mode that consults the mark is inoperable without the
	 * marking event: every caller would be unmarked and the remote tier
	 * would be unreachable. Refuse rather than serve a silent host-only
	 * filesystem that looks like a containment success. */
	if (route_mode != R_PATH && !mark_path) {
		fprintf(stderr, "fuse-union-s3: REFUSED — FUSE_S3_ROUTE=%s needs "
				"FUSE_S3_MARK_PATH\n", rm);
		return 1;
	}
	atexit(idstats_dump);

	if (!rr || !pf) {
		fprintf(stderr, "fuse-union-s3: REFUSED — FUSE_S3_REMOTE and "
				"FUSE_S3_PINS are both required\n");
		return 1;
	}
	snprintf(host_root,   sizeof(host_root),   "%s", hr);
	snprintf(remote_root, sizeof(remote_root), "%s", rr);

	pins_load(pf);
	/* The mountpoint lies inside BOTH roots, so an unguarded union recurses
	 * forever the first time anything walks the tree. S1 §7.5. */
	if (mp)
		pin_add(T_HIDE, mp);

	if ((host_fd = open(host_root, O_PATH | O_DIRECTORY)) == -1) {
		fprintf(stderr, "fuse-union-s3: host root %s: %s\n",
			host_root, strerror(errno));
		return 1;
	}
	if ((remote_fd = open(remote_root, O_PATH | O_DIRECTORY)) == -1) {
		fprintf(stderr, "fuse-union-s3: remote root %s: %s\n",
			remote_root, strerror(errno));
		return 1;
	}
	if (tp) {
		if (!(trace_fp = fopen(tp, "a"))) {
			fprintf(stderr, "fuse-union-s3: trace %s: %s\n", tp, strerror(errno));
			return 1;
		}
		setvbuf(trace_fp, NULL, _IOLBF, 0);
	}
	if (fp) {
		if (!(fb_fp = fopen(fp, "a"))) {
			fprintf(stderr, "fuse-union-s3: fallback log %s: %s\n", fp, strerror(errno));
			return 1;
		}
		setvbuf(fb_fp, NULL, _IOLBF, 0);
	}

	fprintf(stderr, "fuse-union-s3: host=%s remote=%s pins=%zu guard=%s "
		"route=%s validate=%s markpath=%s tgid=%d\n",
		host_root, remote_root, npins, guard_enabled ? "on" : "OFF",
		rm ? rm : "path", mark_validate ? "always" : "cached",
		mark_path ? mark_path : "(none)", (int)self_tgid);

	umask(0);
	return fuse_main(argc, argv, &pt_ops, NULL);
}

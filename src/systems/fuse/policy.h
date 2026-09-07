/*
 * policy.h — the union daemon's POLICY, separated from its libfuse surface.
 *
 * This header includes no libfuse header and calls no FUSE function. That is
 * its whole point: everything here can be driven from a plain C program with
 * fake inputs, so the tier resolution, the caller-marking rules, the resolution
 * cache and the control-frame codec are proven before anything is mounted.
 * `union.c` #includes it and keeps every op body that talks to libfuse.
 *
 * THE BOUNDARY IS "WHAT CAN BE DRIVEN DETERMINISTICALLY", not "what has no
 * includes". Where the policy needs the kernel it takes an injected reader:
 *
 *   policy_proc   /proc field-22 starttime and TID->TGID, injected so pid reuse
 *                 and TID/TGID confusion are reproducible without forking.
 *   policy_clock  monotonic milliseconds, injected so the resolution cache's
 *                 TTL is proven without sleeping.
 *   ccu_xport     the control-channel round trip, injected so the frame codec
 *                 and the reply->errno mapping are proven without a socket.
 *
 * WHAT IS DELIBERATELY NOT PROVABLE HERE, stated so a later SURVIVED is read
 * against a known boundary rather than argued about (plan 2026-0355 §7.1):
 *
 *   tier resolution   that pt_getattr/pt_opendir CALL resolve_class(), and that
 *                     `mount --bind` succeeds onto a synthetic node
 *   marking policy    that fuse_get_context()->pid is the TID in practice, and
 *                     that the marking event fires on the CLI's real first read
 *   frame codec       the socket transport itself, its blocking behaviour under
 *                     libfuse's multithreaded loop, and EIO on a dead cc
 *
 * Every one of those is a real-gate arm (tests/fuse-lifecycle.real.test.mjs).
 *
 * Header-only, and every function is `static inline`, so an including TU that
 * uses half of it draws no unused-function warning.
 */
#ifndef CC_UNION_POLICY_H
#define CC_UNION_POLICY_H

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

/* ── the tier table ─────────────────────────────────────────────────────── */

/*
 * T_FAIL IS INDEX 0, AND THAT ONE TOKEN IS THE POLICY.
 *
 * `tier_of` returns index 0 for a path no pin matches, so index 0 is the answer
 * for everything cc did not name. The spike instrument this file forked from
 * put T_DEFAULT there — remote-first with a host fallback — and that fallback
 * is the "one path, two answers" the epic exists to remove. Fail-closed by
 * construction: an unpinned path is served from neither side.
 *
 * T_SYNTH is DERIVED, never parsed from the pins file: `pins_load` rejects it
 * as an unknown kind. See the ancestor derivation below for why it has to
 * exist at all.
 */
enum tier { T_FAIL = 0, T_HOST, T_PROJECT, T_HIDE, T_BIND, T_SYNTH };

static inline const char *tier_name(enum tier t)
{
	switch (t) {
	case T_HOST:    return "host";
	case T_PROJECT: return "project";
	case T_HIDE:    return "hide";
	case T_BIND:    return "bind";
	case T_SYNTH:   return "synth";
	case T_FAIL:    break;
	}
	return "fail";
}

struct pin {
	enum tier tier;
	char   prefix[PATH_MAX];
	size_t len;
};

#define MAX_PINS 512
static struct pin pins[MAX_PINS];
static size_t     npins = 0;

/* The last parse refusal, so `pins_load` can print it and a unit driver can
 * assert on it without the process exiting. */
static char policy_err[256];

static inline int pin_add(enum tier t, const char *prefix)
{
	struct pin *p;
	size_t n;

	if (npins >= MAX_PINS) {
		snprintf(policy_err, sizeof(policy_err), "too many pins (max %d)", MAX_PINS);
		return -1;
	}
	p = &pins[npins++];
	p->tier = t;
	snprintf(p->prefix, sizeof(p->prefix), "%s", prefix);
	n = strlen(p->prefix);
	while (n > 1 && p->prefix[n - 1] == '/')
		p->prefix[--n] = '\0';
	p->len = n;
	return 0;
}

/*
 * Longest prefix wins. A prefix matches a path when the path IS it or lies
 * under it at a component boundary -- "/tmp/apple" must not match the pin
 * "/tmp/app", which a bare strncmp would happily do.
 */
static inline enum tier tier_of(const char *path)
{
	enum tier best_t = T_FAIL;
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

/* An EXACT pin on this path, as opposed to one that merely covers it. */
static inline const struct pin *pin_exact(const char *path)
{
	size_t i;
	for (i = 0; i < npins; i++)
		if (strcmp(pins[i].prefix, path) == 0)
			return &pins[i];
	return NULL;
}

/*
 * One pins-file line. Split out of `pins_load` so the parse — the comment and
 * blank skip, the kind allow-list, the absolute-path rule — is drivable without
 * a file and without the process exiting. Returns 0 on success (including a
 * line that carried no pin), -1 with `policy_err` set.
 *
 * DESTRUCTIVE: it NUL-terminates the kind in place, as the rig's loop did.
 */
static inline int pins_parse_line(char *line)
{
	char *kind, *prefix, *nl;

	if ((nl = strchr(line, '\n')))
		*nl = '\0';
	kind = line + strspn(line, " \t");
	if (*kind == '\0' || *kind == '#')
		return 0;
	prefix = kind + strcspn(kind, " \t");
	if (*prefix == '\0') {
		snprintf(policy_err, sizeof(policy_err), "no path on line '%s'", kind);
		return -1;
	}
	*prefix++ = '\0';
	prefix += strspn(prefix, " \t");
	if (*prefix != '/') {
		snprintf(policy_err, sizeof(policy_err), "not absolute: '%s'", prefix);
		return -1;
	}
	if      (strcmp(kind, "host")    == 0) return pin_add(T_HOST,    prefix);
	else if (strcmp(kind, "project") == 0) return pin_add(T_PROJECT, prefix);
	else if (strcmp(kind, "hide")    == 0) return pin_add(T_HIDE,    prefix);
	else if (strcmp(kind, "bind")    == 0) return pin_add(T_BIND,    prefix);
	else if (strcmp(kind, "fail")    == 0) return pin_add(T_FAIL,    prefix);
	snprintf(policy_err, sizeof(policy_err), "unknown kind '%s'", kind);
	return -1;
}

/* ── the synthetic ancestors ────────────────────────────────────────────── */
/*
 * Criterion 2's four classes are not literally implementable on their own: with
 * T_FAIL at index 0, "/" is fail and path resolution has no traversable root,
 * so nothing under any pin is reachable. The fifth class is DERIVED from the
 * same artifact rather than hand-listed — every strict ancestor of every pin,
 * plus "/", minus any path that already carries an exact pin. Adding a pin
 * therefore grows its ancestors automatically and no ancestor is ever written
 * down twice.
 *
 * Each ancestor keeps the index it was assigned at load, which is what gives a
 * synthetic node a STABLE inode for the life of the mount.
 */
#define MAX_ANC 8192
struct anc { char path[PATH_MAX]; size_t len; };
static struct anc ancs[MAX_ANC];
static size_t     nancs = 0;

/* Synthetic inodes live in a range no real filesystem on this host hands out,
 * so `use_ino = 1` cannot make a synthetic node collide with a host one. */
#define SYNTH_INO_BASE 0x7000000000000000ULL

static inline int anc_find(const char *path)
{
	size_t i;
	for (i = 0; i < nancs; i++)
		if (strcmp(ancs[i].path, path) == 0)
			return (int)i;
	return -1;
}

static inline void anc_add(const char *path)
{
	if (anc_find(path) >= 0 || nancs >= MAX_ANC)
		return;
	snprintf(ancs[nancs].path, sizeof(ancs[nancs].path), "%s", path);
	ancs[nancs].len = strlen(ancs[nancs].path);
	nancs++;
}

/*
 * Derive the ancestor set from the pins already loaded. Idempotent enough to be
 * called once, after every pin_add the daemon does (pins_load plus the
 * mountpoint's implicit `hide`).
 */
static inline void anc_build(void)
{
	size_t i;

	nancs = 0;
	/* "/" first, so its index — and therefore the root's inode — does not
	 * depend on the order pins happened to arrive in. */
	anc_add("/");
	for (i = 0; i < npins; i++) {
		char buf[PATH_MAX];
		char *slash;
		snprintf(buf, sizeof(buf), "%s", pins[i].prefix);
		for (;;) {
			slash = strrchr(buf, '/');
			if (!slash || slash == buf)
				break;
			*slash = '\0';
			anc_add(buf);
		}
	}
	/* A path that carries an exact pin is that pin's tier, not a synthetic
	 * node: the pin is the more specific statement. */
	{
		size_t w = 0, r;
		for (r = 0; r < nancs; r++) {
			if (pin_exact(ancs[r].path))
				continue;
			if (w != r)
				ancs[w] = ancs[r];
			w++;
		}
		nancs = w;
	}
}

/*
 * THE ONE CLASSIFIER. `tier_of` plus the derived fifth class, and every op body
 * in union.c goes through it. A path is synthetic only where it is EXACTLY a
 * member of the ancestor set — membership by prefix would make every leaf under
 * an unpinned directory a directory too.
 */
static inline enum tier resolve_class(const char *path)
{
	enum tier t = tier_of(path);
	if (t == T_FAIL && anc_find(path) >= 0)
		return T_SYNTH;
	return t;
}

/*
 * A synthetic node's attributes, and they are FIXED. Existence, mtime and size
 * are exactly what the tier table withholds, so this must never consult the
 * host directory of the same name: `/usr` inside the chroot is a scaffold cc
 * built to make its pins reachable, not the host's `/usr` seen through a
 * keyhole. Nothing here touches the filesystem, which is what makes that
 * structural rather than a habit.
 *
 * 0555 root:root, nlink 2, size 0, all three times 0.
 */
static inline unsigned long long policy_bind_ino(const char *path);

static inline int policy_synth_getattr(const char *path, struct stat *st)
{
	int idx = anc_find(path);
	unsigned long long ino;

	if (idx >= 0)
		ino = SYNTH_INO_BASE + (unsigned long long)idx;
	else if (resolve_class(path) == T_BIND)
		ino = policy_bind_ino(path);
	else
		return -ENOENT;
	memset(st, 0, sizeof(*st));
	st->st_mode  = S_IFDIR | 0555;
	st->st_nlink = 2;
	st->st_uid   = 0;
	st->st_gid   = 0;
	st->st_size  = 0;
	st->st_ino   = ino;
	return 0;
}

/*
 * A `bind` node needs an inode too — bootstrap.sh mounts the orchestrator's own
 * /proc, /sys and /dev over these three, and a bind target has to exist as a
 * directory first. They are not in the ancestor set (they carry an exact pin),
 * so they take an index past its end.
 */
static inline unsigned long long policy_bind_ino(const char *path)
{
	size_t i;
	for (i = 0; i < npins; i++)
		if (strcmp(pins[i].prefix, path) == 0)
			return SYNTH_INO_BASE + MAX_ANC + i;
	return SYNTH_INO_BASE + MAX_ANC;
}

/*
 * The immediate children of a synthetic directory, and NOTHING ELSE. A
 * synthetic dir that also listed the host's would be exactly the leak criterion
 * 3 forbids: the host's `/usr` has hundreds of names the chroot cannot serve.
 *
 * WHAT IS OMITTED, and why it is not the same rule as "pinned children":
 *   T_HIDE  the union's own scaffolding — the rig suppressed it from every
 *           listing and that is carried unchanged.
 *   T_FAIL  a name whose every op answers -ENOENT. Listing it would put `ls`
 *           and `cat` in disagreement about whether a file exists, from one
 *           caller — the same defect the merged readdir existed to avoid.
 *
 * Calls `cb` once per child with the child's own class. Returns the count.
 */
static inline size_t policy_synth_children(const char *dir,
                                           void (*cb)(void *ctx, const char *name,
                                                      const char *full, enum tier t),
                                           void *ctx)
{
	size_t dlen = strcmp(dir, "/") == 0 ? 0 : strlen(dir);
	size_t emitted = 0;
	size_t i, src;

	/* pins first, then ancestors: both sets are disjoint by construction
	 * (anc_build drops any ancestor carrying an exact pin), so no dedupe. */
	for (src = 0; src < 2; src++) {
		size_t n = src == 0 ? npins : nancs;
		for (i = 0; i < n; i++) {
			const char *full = src == 0 ? pins[i].prefix : ancs[i].path;
			const char *name;
			enum tier t;

			if (strncmp(full, dir, dlen) != 0 || full[dlen] != '/')
				continue;
			name = full + dlen + 1;
			if (*name == '\0' || strchr(name, '/'))
				continue;      /* not an IMMEDIATE child */
			t = src == 0 ? pins[i].tier : T_SYNTH;
			if (t == T_HIDE || t == T_FAIL)
				continue;
			cb(ctx, name, full, t);
			emitted++;
		}
	}
	return emitted;
}

/*
 * WHAT EVERY MUTATING OP OWES A SYNTHETIC OR BIND NODE, in ONE place so the
 * choice is a fact of the policy rather than of twelve op bodies.
 *
 * EROFS, NOT EACCES, AND THAT IS PINNED. The node is a read-only scaffold cc
 * derived from the pin list; EACCES would tell the caller a permissions fix
 * exists, and there is none — there is nothing behind the node to chmod.
 *
 * 0 = the op may proceed.
 */
static inline int policy_mutation_check(enum tier t)
{
	return (t == T_SYNTH || t == T_BIND) ? -EROFS : 0;
}

/* ── caller identity, over an injected /proc reader ─────────────────────── */

struct proc_reader {
	/* /proc/<pid>/stat field 22, the process start time in clock ticks. */
	unsigned long long (*starttime)(pid_t);
	/* /proc/<pid>/status Tgid, i.e. the thread's thread-group leader. */
	pid_t              (*tgid)(pid_t);
};

static inline unsigned long long policy_real_starttime(pid_t pid);
static inline pid_t              policy_real_tgid(pid_t pid);

static struct proc_reader policy_proc = { policy_real_starttime, policy_real_tgid };

/*
 * Field 22 of /proc/<pid>/stat is the process start time in clock ticks. It is
 * the only cheap thing that distinguishes a recycled pid from its predecessor.
 * Parsing must start AFTER the comm field, which is parenthesised and may
 * itself contain spaces and ')' -- so scan to the LAST ')' rather than the
 * first, which is the classic way this parse goes wrong.
 */
static inline unsigned long long policy_real_starttime(pid_t pid)
{
	char buf[64], line[1024], *p;
	unsigned long long st = 0;
	int f, field;
	ssize_t n;

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

static inline pid_t policy_real_tgid(pid_t pid)
{
	char buf[64], line[256];
	pid_t tgid = -1;
	FILE *f;

	snprintf(buf, sizeof(buf), "/proc/%d/status", (int)pid);
	if (!(f = fopen(buf, "r")))
		return -1;
	while (fgets(line, sizeof(line), f))
		if (strncmp(line, "Tgid:", 5) == 0) {
			tgid = (pid_t)atoi(line + 5);
			break;
		}
	fclose(f);
	return tgid;
}

/* ── the CLAUDE mark ────────────────────────────────────────────────────── */
/*
 * A THREAD GROUP is marked the first time it resolves the CLI's own binary.
 * Two measurements from S1 fix the key and the validation, and neither is a
 * tuning knob any more — the spike's flags are gone and both behaviours are
 * unconditional:
 *
 *   THE KEY IS THE TGID, NOT THE CALLING TID. in_header.pid is the TID (S1 §6
 *   Q1: 983 of 14 677 ops had pid != tgid), so a mark recorded against a TID
 *   would be invisible to every other thread of the same process.
 *
 *   FIELD 22 IS RE-READ ON EVERY CHECK. A marked TGID that exits can have its
 *   pid recycled and FUSE gets no process-exit notification, so the successor
 *   would inherit CLAUDE status. A live process's start time never changes, so
 *   a mismatch means this is not the process that was marked.
 */
#define MARK_SLOTS 4096
struct mark { pid_t tgid; unsigned long long start; };
static struct mark      marks[MARK_SLOTS];
static size_t           nmarks = 0;
static pthread_mutex_t  mark_mu = PTHREAD_MUTEX_INITIALIZER;

static inline void mark_add(pid_t tgid, unsigned long long start)
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

/* 1 = this thread group is marked CLAUDE, and still the process that was. */
static inline int mark_of(pid_t tgid)
{
	unsigned long long want = 0, now;
	size_t i;
	int hit = 0;

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
	/* THE PID-REUSE GATE. */
	now = policy_proc.starttime(tgid);
	if (now == want)
		return 1;
	pthread_mutex_lock(&mark_mu);
	for (i = 0; i < nmarks; i++)
		if (marks[i].tgid == tgid) {
			marks[i] = marks[nmarks - 1];
			nmarks--;
			break;
		}
	pthread_mutex_unlock(&mark_mu);
	return 0;
}

/* THE MARKING EVENT and THE MARK CHECK, both taking the CALLING THREAD's id and
 * resolving it to a thread group through the injected reader. Every caller in
 * union.c hands these `fuse_get_context()->pid`, which is a TID. */
static inline void policy_mark_tid(pid_t tid)
{
	pid_t tgid = policy_proc.tgid(tid);
	if (tgid > 0)
		mark_add(tgid, policy_proc.starttime(tgid));
}

static inline int policy_is_marked_tid(pid_t tid)
{
	return mark_of(policy_proc.tgid(tid));
}

/* ── the caller-aware resolution cache ──────────────────────────────────── */
/*
 * Criterion 7's daemon half: the kernel caches nothing (attr_timeout=0,
 * entry_timeout=0, negative_timeout=0 in the mount options, kernel_cache=0 in
 * pt_init), because FUSE's attribute cache is per-INODE and this filesystem
 * answers per-CALLER. This is the replacement.
 *
 * WHAT A RESOLUTION IS, and therefore what is cached: for a project path the
 * only question route() asks cc is "may the mirror serve this, and if not with
 * which errno". There is no second backing directory to choose between and no
 * `struct stat` here — the mirror is written by cc's control handler, which the
 * daemon cannot observe, so a cached stat would be served stale with no event
 * able to invalidate it. What a hit removes is the control ROUND TRIP; the
 * local fstatat a hit still performs is the cheap half.
 *
 * THE KEY IS (tgid, path) AND THE tgid IS LOAD-BEARING. The cache is consulted
 * BEFORE the mark check, so it is the tgid in the key — and nothing else — that
 * stops an unmarked caller being served a marked caller's resolution. Drop it
 * and criterion 6 is defeated by a cache rather than by any routing change.
 *
 * FILLED ONLY FOR MARKED CALLERS: the fill happens past the mark check, so an
 * unmarked caller's denial is never written back and the mark's arrival is
 * visible on the next op rather than one TTL later.
 *
 * FETCH NEVER CONSULTS IT — an open always revalidates, so freshness at open is
 * exact and S3's per-open revalidate inherits an exact contract rather than a
 * one-second-stale one.
 */
#define CACHE_SLOTS  1024
#define CACHE_TTL_MS 1000

struct centry {
	pid_t      tgid;
	char      *path;
	int        err;        /* 0 = the mirror may serve it; else the errno */
	long long  expires;
};
static struct centry     cache[CACHE_SLOTS];
static pthread_mutex_t   cache_mu = PTHREAD_MUTEX_INITIALIZER;

static inline long long policy_real_now_ms(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* The clock, injected so the TTL is proven without sleeping. */
static long long (*policy_clock)(void) = policy_real_now_ms;

static inline unsigned long policy_strhash(const char *s)
{
	unsigned long h = 5381;
	while (*s) h = h * 33 + (unsigned char)*s++;
	return h;
}

static inline size_t cache_slot(pid_t tgid, const char *path)
{
	return (policy_strhash(path) ^ ((unsigned long)tgid * 2654435761u)) % CACHE_SLOTS;
}

/* 1 = hit and unexpired; fills *err. */
static inline int cache_get(pid_t tgid, const char *path, int *err)
{
	size_t slot = cache_slot(tgid, path), i;
	int found = 0;

	pthread_mutex_lock(&cache_mu);
	for (i = 0; i < 64; i++) {
		struct centry *e = &cache[(slot + i) % CACHE_SLOTS];
		if (!e->path)
			break;
		if (e->tgid != tgid || strcmp(e->path, path) != 0)
			continue;
		if (policy_clock() >= e->expires)
			break;
		*err = e->err;
		found = 1;
		break;
	}
	pthread_mutex_unlock(&cache_mu);
	return found;
}

static inline void cache_put(pid_t tgid, const char *path, int err)
{
	size_t slot = cache_slot(tgid, path), i;

	pthread_mutex_lock(&cache_mu);
	for (i = 0; i < 64; i++) {
		struct centry *e = &cache[(slot + i) % CACHE_SLOTS];
		if (e->path && (e->tgid != tgid || strcmp(e->path, path) != 0))
			continue;
		if (!e->path) {
			if (!(e->path = strdup(path)))
				break;
			e->tgid = tgid;
		}
		e->err = err;
		e->expires = policy_clock() + CACHE_TTL_MS;
		break;
	}
	pthread_mutex_unlock(&cache_mu);
}

/*
 * A mutation at `path` invalidates `path` — its bytes and its attributes have
 * moved — AND its parent, whose listing has. Across every tgid: the resolution
 * a caller holds says nothing about who mutated the file.
 */
static inline void cache_invalidate(const char *path)
{
	char parent[PATH_MAX];
	char *slash;
	size_t i;

	snprintf(parent, sizeof(parent), "%s", path);
	if ((slash = strrchr(parent, '/')) != NULL)
		*(slash == parent ? slash + 1 : slash) = '\0';

	pthread_mutex_lock(&cache_mu);
	for (i = 0; i < CACHE_SLOTS; i++) {
		struct centry *e = &cache[i];
		if (!e->path)
			continue;
		if (strcmp(e->path, path) == 0 || strcmp(e->path, parent) == 0)
			e->expires = 0;
	}
	pthread_mutex_unlock(&cache_mu);
}

/* ── the control channel: the frame codec ───────────────────────────────── */
/*
 * A FIXED BINARY FRAME AND NO PAYLOAD, EVER. The channel is control-only: it
 * tells cc which path a caller reached and cc materialises it into the mirror,
 * so no file content crosses it and a malformed length can never be a buffer of
 * attacker bytes.
 *
 *   request: u32 magic 'CCU1' | u8 op | u8 flags | u16 pathlen | path[pathlen]
 *   reply:   u32 magic 'CCU1' | u8 status | u8 pad | i32 errno | u32 reserved
 *
 * All multi-byte fields are BIG-ENDIAN, written a byte at a time, so the wire
 * does not depend on the host's word order or on a struct's padding.
 *
 * `errno` is CC'S: cc decides ENOENT/EACCES/EIO rather than the daemon
 * inventing one from a status it did not choose. A well-formed non-READY reply
 * always carries one; the canonical mapping below is what a zero falls back to.
 */
#define CCU_MAGIC      0x43435531u   /* 'C' 'C' 'U' '1' */
#define CCU_REQ_HDR    8u
#define CCU_REPLY_LEN  14u
#define CCU_MAX_PATH   4096u

enum ccu_op     { CCU_STAT = 1, CCU_LIST = 2, CCU_FETCH = 3, CCU_DIRTY = 4 };
enum ccu_status { CCU_READY = 0, CCU_ABSENT = 1, CCU_REFUSED = 2 };

#define CCU_FLAG_FOR_CREATE 0x01

static inline void ccu_put32(unsigned char *p, uint32_t v)
{
	p[0] = (unsigned char)(v >> 24); p[1] = (unsigned char)(v >> 16);
	p[2] = (unsigned char)(v >> 8);  p[3] = (unsigned char)v;
}

static inline uint32_t ccu_get32(const unsigned char *p)
{
	return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
	       ((uint32_t)p[2] << 8)  | (uint32_t)p[3];
}

/*
 * Encode one request. Returns 0 and sets *out_len, or -errno:
 *   -ENAMETOOLONG  the path is longer than CCU_MAX_PATH
 *   -EMSGSIZE      `cap` cannot hold the frame
 */
static inline int ccu_encode_request(unsigned char *buf, size_t cap, uint8_t op,
                                     uint8_t flags, const char *path, size_t *out_len)
{
	size_t plen = strlen(path);

	if (plen > CCU_MAX_PATH)
		return -ENAMETOOLONG;
	if (cap < CCU_REQ_HDR + plen)
		return -EMSGSIZE;
	ccu_put32(buf, CCU_MAGIC);
	buf[4] = op;
	buf[5] = flags;
	buf[6] = (unsigned char)(plen >> 8);
	buf[7] = (unsigned char)plen;
	memcpy(buf + CCU_REQ_HDR, path, plen);
	*out_len = CCU_REQ_HDR + plen;
	return 0;
}

struct ccu_reply { uint8_t status; int32_t err; };

/*
 * Decode one reply. Returns 0, or -EIO for a frame this daemon must not act on:
 * a short frame, a bad magic, or a status outside the enum. Every one of those
 * means the channel is not carrying what cc speaks, and serving a filesystem
 * from a channel in that state is worse than failing the op.
 */
static inline int ccu_decode_reply(const unsigned char *buf, size_t len, struct ccu_reply *out)
{
	if (len != CCU_REPLY_LEN)
		return -EIO;
	if (ccu_get32(buf) != CCU_MAGIC)
		return -EIO;
	if (buf[4] > (uint8_t)CCU_REFUSED)
		return -EIO;
	out->status = buf[4];
	out->err    = (int32_t)ccu_get32(buf + 6);
	return 0;
}

/*
 * The transport, injected. `roundtrip` writes the whole request and reads
 * exactly one reply, returning the reply's length or -errno. A unit driver
 * supplies a function that answers from a table; union.c supplies the
 * per-thread unix socket.
 */
struct ccu_transport {
	ssize_t (*roundtrip)(void *ctx, const unsigned char *req, size_t reqlen,
	                     unsigned char *rep, size_t repcap);
	void *ctx;
};
static struct ccu_transport ccu_xport = { NULL, NULL };

/*
 * One control call. Returns 0 when cc says READY, or the negative errno the op
 * must answer with:
 *
 *   ABSENT   -> cc's errno, or -ENOENT
 *   REFUSED  -> cc's errno, or -EACCES
 *   a dead, wedged or malformed channel -> -EIO
 *
 * -EIO and not a host fallback: a daemon that cannot reach cc must not quietly
 * serve a host-only filesystem, which looks exactly like a containment success.
 */
static inline int ccu_call(uint8_t op, uint8_t flags, const char *path)
{
	unsigned char req[CCU_REQ_HDR + CCU_MAX_PATH];
	unsigned char rep[CCU_REPLY_LEN];
	struct ccu_reply reply;
	size_t reqlen;
	ssize_t got;
	int rc;

	if (!ccu_xport.roundtrip)
		return -EIO;
	if ((rc = ccu_encode_request(req, sizeof(req), op, flags, path, &reqlen)) != 0)
		return rc == -ENAMETOOLONG ? -ENAMETOOLONG : -EIO;
	got = ccu_xport.roundtrip(ccu_xport.ctx, req, reqlen, rep, sizeof(rep));
	if (got < 0)
		return -EIO;
	if (ccu_decode_reply(rep, (size_t)got, &reply) != 0)
		return -EIO;
	switch (reply.status) {
	case CCU_READY:   return 0;
	case CCU_ABSENT:  return reply.err ? -reply.err : -ENOENT;
	default:          return reply.err ? -reply.err : -EACCES;
	}
}

/* ── the refusal log ────────────────────────────────────────────────────── */
/*
 * THE INSTRUMENT THE PIN LIST IS DERIVED FROM, and the thing that must be empty
 * by the end. Every fail-closed path, every REFUSED reply and every unmarked
 * denial lands here, deduplicated on path+reason so a demand-paged 215 MB
 * binary cannot bury the one line that matters. PATHS ONLY, never content: a
 * credential path may appear in it and a credential never does.
 */
static FILE           *refusal_fp = NULL;
static pthread_mutex_t refusal_mu = PTHREAD_MUTEX_INITIALIZER;

#define REFUSAL_SLOTS 65536
static char  *refusal_seen[REFUSAL_SLOTS];
static size_t refusal_n = 0;

/* caller holds refusal_mu */
static inline int refusal_dup(const char *key)
{
	size_t slot, i;

	if (refusal_n >= REFUSAL_SLOTS / 2)
		return 0;                       /* full: stop deduping, keep logging */
	slot = policy_strhash(key) % REFUSAL_SLOTS;
	for (i = 0; i < REFUSAL_SLOTS; i++) {
		char **e = &refusal_seen[(slot + i) % REFUSAL_SLOTS];
		if (!*e) { *e = strdup(key); refusal_n++; return 0; }
		if (strcmp(*e, key) == 0) return 1;
	}
	return 0;
}

static inline void policy_refuse(const char *op, const char *path, const char *reason)
{
	char key[PATH_MAX + 64];

	if (!refusal_fp)
		return;
	snprintf(key, sizeof(key), "%s\t%s", path, reason);
	pthread_mutex_lock(&refusal_mu);
	if (!refusal_dup(key))
		fprintf(refusal_fp, "%s\t%s\t%s\n", op, path, reason);
	pthread_mutex_unlock(&refusal_mu);
}

/* ── the project tier's whole decision, in one place ────────────────────── */
/*
 * CRITERION 6, AND THE ORDER IS THE POLICY.
 *
 * Takes the CALLING THREAD's id — union.c hands it `fuse_get_context()->pid`,
 * which S1 measured to be a TID — and answers 0 (serve the path from the
 * mirror) or a negative errno. It reaches libfuse through nothing, so the whole
 * of it is drivable from a unit fixture with a fake /proc, a fake clock and a
 * fake transport.
 *
 * THE THREE STEPS, IN THIS ORDER AND NO OTHER:
 *
 *  1. THE CACHE, consulted first. That placement is what makes the tgid in the
 *     key load-bearing: an unmarked caller reaches the lookup, and only the
 *     tgid stops it matching a marked caller's warmed entry. FETCH skips it —
 *     an open always revalidates.
 *  2. THE MARK. An UNMARKED caller at a project path gets -ENOENT. Not the
 *     remote's copy, and not a host fallback: the project tier has no host side
 *     by design, so "deny the remote" can only mean "deny". A host-pinned or
 *     bind-mounted path never reaches here and is served to marked and unmarked
 *     callers alike.
 *  3. THE CONTROL CALL. A bare local stat of the mirror would report ENOENT for
 *     a file that exists on the remote and has simply not been materialised
 *     yet, so no remote-tier op touches the mirror before cc has answered.
 */
static inline int policy_project_route(const char *op, const char *path, pid_t tid,
                                       uint8_t fop, uint8_t flags)
{
	pid_t tgid = policy_proc.tgid(tid);
	int cached = 0, rc;

	if (fop != (uint8_t)CCU_FETCH && cache_get(tgid, path, &cached))
		return cached;

	if (!mark_of(tgid)) {
		policy_refuse(op, path, "unmarked-project-denied");
		return -ENOENT;
	}

	rc = fop ? ccu_call(fop, flags, path) : 0;
	if (fop == (uint8_t)CCU_FETCH)
		/*
		 * A FETCH IS ALSO THE INVALIDATION, and it is the only one the
		 * mutating ops need: every op that can change a file routes with
		 * FETCH, and `cache_invalidate` clears the path AND its parent
		 * across every tgid.
		 *
		 * It also closes a `stat`-says-no/`cat`-says-yes window that a
		 * consult-skipping FETCH would otherwise leave open: a cached
		 * -ENOENT from an earlier STAT would outlive the FETCH that
		 * found the file, and one caller would get two answers for one
		 * path.
		 */
		cache_invalidate(path);
	else if (fop)
		cache_put(tgid, path, rc);
	/* Three distinct reasons, because the refusal log is what the pin list is
	 * DERIVED from and "the remote does not have it" is a different finding
	 * from "cc would not carry it" and from "cc could not be reached". */
	if (rc == -EIO)         policy_refuse(op, path, "control-unavailable");
	else if (rc == -ENOENT) policy_refuse(op, path, "remote-absent");
	else if (rc)            policy_refuse(op, path, "control-refused");
	return rc;
}

#endif /* CC_UNION_POLICY_H */

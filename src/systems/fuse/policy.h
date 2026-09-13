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
 *   policy_proc   /proc field-22 starttime, TID->TGID, comm and cmdline,
 *                 injected so pid reuse, TID/TGID confusion and an argv full of
 *                 NULs and newlines are reproducible without forking.
 *   policy_clock  monotonic milliseconds, injected so the resolution cache's
 *                 TTL is proven without sleeping.
 *   ccu_xport     the control-channel round trip, injected so the frame codec
 *                 and the reply->errno mapping are proven without a socket.
 *   policy_host_fd  an O_PATH fd on the host root, injected so the
 *                 host-absence probe below is driven against a tree the
 *                 fixture built rather than against the box's own filesystem.
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

/* ── the two views ──────────────────────────────────────────────────────── */
/*
 * ONE RULE, TWO VIEWS, AND NO GEOMETRY IN EITHER (card 2026-0398). `VIEW_CLI` is
 * what the MARKED CLI resolves against: the whole tier table, unchanged by that
 * card. `VIEW_HOST` is what EVERYONE ELSE resolves against, and it is the rule
 * in one sentence — the union subtracts nothing from the orchestrator's own
 * filesystem and adds only what the chroot cannot run without. Mechanically that
 * is two subtractions from the table and no third:
 *
 *   1. THE `project` PINS ARE STRUCK (tier_of), so the remote tier is not in
 *      this view at all. That is what makes "an unmarked caller never receives
 *      remote file content" STRUCTURAL rather than guarded: `tier_of` cannot
 *      return T_PROJECT here, so no unmarked resolution can name the remote,
 *      send a control frame or read the mirror.
 *   2. THE ANCESTOR TABLE IS NOT CONSULTED (resolve_class), because a synthetic
 *      read-only node standing in for a directory the orchestrator HAS is a
 *      subtraction — epic criterion 4 calls it "a violation, not a rounding".
 *      Such a path falls to `fail`, and `fail` means host.
 *
 * The one thing this view ADDS is the OVERLAY: a traverse-only node at a
 * component of the CLI's cwd the orchestrator does not have. It is irreducible —
 * a floor changes a mode, and at `systemPath` there is no node to put a mode on,
 * so `chdir` would get -ENOENT at every geometry including today's default.
 *
 * WHY THE UNMARKED ANSWERS DO NOT VARY WITH THE GEOMETRY, which is the property
 * that makes 2026-0398's bug unreachable rather than merely fixed: with the
 * `project` entries struck, the pin list an unmarked caller resolves against does
 * not mention `mirrorRoot` at all, and the cwd chain does not vary with it
 * either, because `mirrorRoot` is always an ancestor-or-equal of `systemPath`,
 * which IS the cwd. `b38` asserts that identity across three geometries.
 */
enum view { VIEW_CLI = 0, VIEW_HOST };

/* ── the tier table ─────────────────────────────────────────────────────── */

/*
 * T_FAIL IS INDEX 0, AND THAT ONE TOKEN IS THE POLICY.
 *
 * `tier_of` returns index 0 for a path no pin matches, so index 0 is the answer
 * for everything cc did not name. The spike instrument this file forked from
 * put T_DEFAULT there — remote-first with a host fallback — and that fallback
 * is the "one path, two answers" the epic exists to remove. Fail-closed by
 * construction: an unpinned path is served from neither side TO THE MARKED CLI.
 *
 * IT IS ALSO A CALLER-SENSITIVE CLASS. For an UNMARKED caller
 * `policy_caller_tier` substitutes T_HOST, because `fail` is a statement about
 * cc's pin list and an unmarked caller was never going to be served the remote.
 * The set is `{T_FAIL, T_PROJECT, T_SYNTH}` — see
 * policy_tier_is_caller_sensitive, which is an OPTIMISATION over the view and
 * not a rule of its own.
 *
 * T_SYNTH is DERIVED, never parsed from the pins file: `pins_load` rejects it
 * as an unknown kind. See the ancestor derivation below for why it has to
 * exist at all — and note the derivation is `VIEW_CLI`'s alone: in `VIEW_HOST`
 * the same enumerator carries the OVERLAY node instead, which is keyed on the
 * cwd chain and on nothing else.
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
 *
 * IN `VIEW_HOST` THE `project` PINS ARE SKIPPED, and that one `continue` is half
 * the rule. It is not a filter applied to the answer: a struck pin does not
 * enter the longest-prefix contest at all, so a SHORTER host or bind pin can win
 * it, and the path lands where the orchestrator's own filesystem puts it rather
 * than at a blanket refusal.
 */
static inline enum tier tier_of(const char *path, enum view v)
{
	enum tier best_t = T_FAIL;
	size_t    best   = 0;
	size_t    i;

	for (i = 0; i < npins; i++) {
		const struct pin *p = &pins[i];
		if (v == VIEW_HOST && p->tier == T_PROJECT)
			continue;
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
 *
 * THE TWO VIEWS DIVERGE HERE AS WELL AS IN `tier_of`, AND THAT SECOND DIVERGENCE
 * IS WHY `policy_tier_is_caller_sensitive` CARRIES T_SYNTH. `VIEW_HOST` does not
 * consult the ancestor table: a scaffold node over a directory the orchestrator
 * HAS is a subtraction, so in that view such a path is `fail` — and `fail` means
 * host. Its only synthetic nodes come from the OVERLAY below.
 *
 * THE OVERLAY: a traverse-only directory where the orchestrator has none and the
 * chroot cannot run without one. Its two conjuncts and their ORDER are a
 * correctness requirement rather than a style: `policy_cwd_component` is a
 * bounded string compare and `policy_host_absent` is a syscall, and this
 * function is called once PER DIRENT in readdir's real arm. Reverse them and a
 * listing of a large directory pays one fstatat per entry.
 *
 * The probe is deliberately PER-OP and not cached at mount. The set needing the
 * decision is `depth(cwd)` paths behind a string compare, so the cost is a
 * handful of fstatats per process spawn — and a cache would buy that back for a
 * stale window in which the orchestrator GAINS a directory and a cached "absent"
 * keeps a synthetic node over real host data, hiding it silently. That is what
 * constraints 1 and 2 forbid.
 */
static inline int policy_cwd_component(const char *path);
static inline int policy_host_absent(const char *path);

static inline enum tier resolve_class(const char *path, enum view v)
{
	enum tier t = tier_of(path, v);

	if (v == VIEW_CLI)
		return (t == T_FAIL && anc_find(path) >= 0) ? T_SYNTH : t;
	if (t == T_FAIL && policy_cwd_component(path) && policy_host_absent(path))
		return T_SYNTH;
	return t;
}

/*
 * A synthetic node's ATTRIBUTES, and they are FIXED. Existence, mtime and size
 * are exactly what the tier table withholds, so this must never consult the
 * host directory of the same name: `/usr` inside the chroot is a scaffold cc
 * built to make its pins reachable, not the host's `/usr` seen through a
 * keyhole. Nothing here touches the filesystem, which is what makes that
 * structural rather than a habit.
 *
 * H9 IS A RULE ABOUT ATTRIBUTES AND NOT ABOUT NAMES, and the scope has to be
 * said out loud because a reader will otherwise take it as forbidding the merge
 * that now happens. `policy_fixed_dir`'s fixed mode, nlink, size and times are
 * what would disclose the orchestrator's metadata, and they are untouched.
 * `pt_readdir`'s `VIEW_HOST` arm reads the orchestrator's directory for NAMES,
 * and `policy_table_child_exists` probes it for EXISTENCE — neither reports a
 * single attribute of it, and `pinned_children_emit`'s own host probe was always
 * the precedent that the generalisation "a synthetic node must not stat the
 * host" was too broad.
 *
 * 0555 root:root, nlink 2, size 0, all three times 0.
 */
static inline unsigned long long policy_bind_ino(const char *path);
static inline unsigned long long policy_cwd_ino(const char *path);

/* A fixed directory node's attributes. The MODE is the caller's, because the
 * two classes make two different statements and each is pinned on its own. */
static inline void policy_fixed_dir(struct stat *st, mode_t mode, unsigned long long ino)
{
	memset(st, 0, sizeof(*st));
	st->st_mode  = S_IFDIR | mode;
	st->st_nlink = 2;
	st->st_uid   = 0;
	st->st_gid   = 0;
	st->st_size  = 0;
	st->st_ino   = ino;
}

/*
 * ONE MODE FOR BOTH SYNTHETIC CLASSES — 0555 — AND THE ARGUMENT THAT KEPT THEM
 * APART IS DISSOLVED RATHER THAN OVERRULED. Until card 2026-0398 the cwd node
 * was 0111, traverse-only, because it sat over a PROJECT path where a listing
 * could name remote content; 0555 there would have handed an unmarked caller
 * "the content of these remote directories", which the 2026-09-08 amendment
 * forbade. With the remote struck from `VIEW_HOST` the overlay node's listing is
 * EMPTY, BUT NOT FOR THE REASON FIRST WRITTEN DOWN, AND THE CORRECTION MATTERS
 * BECAUSE THE FALSE VERSION WOULD LET A READER DELETE THE CHECK THAT MAKES IT
 * TRUE. It is NOT that "`policy_synth_children` finds no pin or ancestor under a
 * path the orchestrator does not have" — that function scans the PIN TABLE,
 * which knows nothing about what the orchestrator holds, and an `exclude` or a
 * deeper pin under the project puts names there readily. The emptiness comes
 * from the EMIT: `policy_table_child_exists` drops every table name the
 * orchestrator does not have, and it has nothing under a path it has nothing
 * at. What survives is fixed nodes, which name nothing remote either. So the
 * node's listing names nothing remote, and the reason for the split is gone. `policy_mutation_check`'s -EROFS still applies
 * and is still right: the orchestrator has nothing at this path, so constraint 1
 * owes nothing there.
 *
 * THE INODE COMES FROM THE VIEW'S OWN RANGE. `policy_cwd_ino` has a sub-range
 * disjoint from the ancestor and exact-pin ranges precisely because the chain
 * covers intermediate components with NO exact pin, which `policy_bind_ino`
 * would collapse to one shared fallback; `b27` pins the disjointness.
 */
static inline int policy_synth_getattr(const char *path, struct stat *st, enum view v)
{
	int idx = v == VIEW_CLI ? anc_find(path) : -1;
	unsigned long long ino;

	if (idx >= 0)
		ino = SYNTH_INO_BASE + (unsigned long long)idx;
	else if (resolve_class(path, v) == T_BIND)
		ino = policy_bind_ino(path);
	else if (v == VIEW_HOST && resolve_class(path, v) == T_SYNTH)
		ino = policy_cwd_ino(path);
	else
		return -ENOENT;
	policy_fixed_dir(st, 0555, ino);
	return 0;
}

/*
 * THE INODE OF AN EXACTLY-PINNED NODE, for the ONE fixed-node class that needs
 * one: a `bind` target. bootstrap.sh mounts the orchestrator's own /proc, /sys
 * and /dev over these three, and a bind target has to exist as a directory
 * first. It is not in the ancestor set (it carries an exact pin), so it takes an
 * index past its end.
 *
 * IT DOES NOT SERVE THE CWD NODE, AND MUST NOT BE MADE TO. It returns ONE
 * shared fallback for anything unpinned, and the cwd chain covers intermediate
 * components with no exact pin — so every one of them would report the same
 * st_ino. `policy_cwd_ino` has its own disjoint sub-range for exactly that
 * reason; see its comment for what observes the difference.
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
 * CAN THIS VIEW OPEN THIS CHILD? THE DIRENT STREAM'S WHOLE RULE, in one place so
 * both of `pt_readdir`'s arms and the pinned-children collector ask the same
 * question — card 2026-0403 was two instances of the same defect, one per arm.
 *
 *   T_HIDE  invisible to EVERYONE. It is what keeps the mirror and cc's control
 *           socket unreachable, and it is the reason constraint 2 reads
 *           "everything of the host except cc's own run directory": that
 *           exception is FORCED by constraint 3, not chosen.
 *   T_FAIL  invisible to the CLI, whose every op at such a name answers -ENOENT;
 *           VISIBLE to everyone else, because `fail -> host` serves it
 *           unconditionally. The old caller-insensitive filter took the CLI's
 *           answer for both, so an unmarked `ls /tmp` emitted nothing while
 *           `cat /tmp/x` returned its bytes — measured at a real mount, card
 *           2026-0398 step 0.
 *
 * Everything else — host, bind, synth, and project to the CLI that may have it —
 * is a name that view can open, so it is a name that view must see.
 */
static inline int policy_dirent_visible(const char *child, enum view v)
{
	enum tier t = resolve_class(child, v);

	if (t == T_HIDE)
		return 0;
	if (t == T_FAIL)
		return v == VIEW_HOST;
	return 1;
}

/*
 * AND THE OTHER HALF: IS THERE ANYTHING THERE? `policy_dirent_visible` answers
 * "may this view SEE this name"; it does not answer "is there anything to
 * open". Conflating the two put three separate `ls`/`cat` disagreements into
 * card 2026-0398's first round, one per emit site, and this is the predicate
 * that separates them.
 *
 * THE RULE IS ONE SENTENCE: a FIXED NODE exists by construction, and everything
 * else exists exactly where the orchestrator has it. What makes it view-shaped
 * is not the sentence but WHICH PATHS ARE FIXED NODES — the ancestor table in
 * `VIEW_CLI`, the cwd overlay in `VIEW_HOST` — so the same child can be a node
 * that certainly exists to one caller and a host question to the other.
 *
 * WHY THE PIN'S OWN TIER IS THE WRONG THING TO ASK, and this is the trap: a
 * `project` pin at the cwd resolves to the OVERLAY for an unmarked caller, so
 * branching on the pin tier host-checks a node that exists by construction and
 * drops it — `stat <systemPath>` answering and `cd` working while `ls` of its
 * parent omits the name. Resolve in the view, then ask.
 *
 * PROBED THROUGH `policy_host_absent`, so the failure direction is the one that
 * function documents: an unknown error answers "not absent", which here means
 * the name is EMITTED and the host answers for it — loud, rather than a name
 * silently missing from a listing.
 *
 * IT IS NOT ASKED ON A `VIEW_CLI` SYNTHETIC NODE'S OWN CHILDREN, and union.c
 * says why at the call site: there the scaffold has no backing store at all and
 * a `project` child's existence is a question only a control frame could answer,
 * which a synthetic node must not send.
 */
static inline int policy_table_child_exists(const char *child, enum view v)
{
	enum tier t = resolve_class(child, v);

	if (t == T_SYNTH || t == T_BIND)
		return 1;               /* a fixed node: it exists by construction */
	return !policy_host_absent(child);
}

/*
 * The immediate children of a synthetic directory, and NOTHING ELSE. A
 * synthetic dir that also listed the host's would be exactly the leak criterion
 * 3 forbids for the MARKED CLI: the host's `/usr` has hundreds of names the
 * chroot cannot serve. (`VIEW_HOST` merges the orchestrator's own names in
 * `pt_readdir`'s synthetic arm, where the node has no remote behind it at all —
 * union.c states why that is not the same rule.)
 *
 * WHAT IS OMITTED IS `policy_dirent_visible`'s DECISION, not a second copy of
 * it: `hide` never, `fail` to the CLI alone. Asking one predicate is what keeps
 * the two arms from drifting.
 *
 * Calls `cb` once per child with the child's own class. Returns the count.
 */
static inline size_t policy_synth_children(const char *dir, enum view v,
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
			if (!policy_dirent_visible(full, v))
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

/*
 * WHAT A PROJECT-TIER OP OWES WHEN THE RECONCILE CANNOT CARRY IT.
 *
 * `DIRTY` means "make the source entry at P match the MIRROR entry at P", so
 * its domain is exactly what a mirror entry can express: a file, a directory,
 * a symlink, or nothing. An op whose effect lives OUTSIDE that — a device node,
 * a hard link's aliasing, an ownership pair in a uid space that is not this
 * machine's, an extended attribute the mirror never carried — cannot be landed
 * by any reconcile, so applying it to the mirror alone would report success
 * having reached the system never. It refuses instead.
 *
 * ONLY AT `project`. A `host` path IS the orchestrator's own file: the op lands
 * on it directly and there is nothing to reconcile.
 *
 * -EOPNOTSUPP, NOT -EPERM, for everything routed through here, and it is the
 * same reasoning that chose -EROFS over -EACCES above: the truth is "this
 * filesystem cannot represent that", and -EPERM would send the caller looking
 * for a privilege that would change the answer. `mknod` keeps -EPERM at its own
 * call site — a container refusing a device node is what a caller already
 * expects there, and it is the one case where the permissions reading is right.
 */
static inline int policy_unreconcilable(enum tier t)
{
	return t == T_PROJECT ? -EOPNOTSUPP : 0;
}

/* ── caller identity, over an injected /proc reader ─────────────────────── */

/*
 * WHAT AN IDENTITY READER RETURNS: the byte count it wrote, or one of these.
 * The count and the two failures are DIFFERENT FACTS and the event log records
 * them as different values — a field that read as a value would say "this
 * process is called <gone>".
 */
#define POLICY_PROC_GONE       (-1)     /* the /proc entry was not there */
#define POLICY_PROC_UNREADABLE (-2)     /* it was, and could not be read */

/* A cmdline can reach ARG_MAX; a log row cannot. Past this the field carries
 * the bytes it did read and says so — see policy_event_field. */
#define POLICY_CMDLINE_MAX 4096

struct proc_reader {
	/* /proc/<pid>/stat field 22, the process start time in clock ticks. */
	unsigned long long (*starttime)(pid_t);
	/* /proc/<pid>/status Tgid, i.e. the thread's thread-group leader. */
	pid_t              (*tgid)(pid_t);
	/* /proc/<pid>/comm and /proc/<pid>/cmdline, NUL-terminated in `out`.
	 * Both return the byte count or a POLICY_PROC_* status. RAW: the cmdline
	 * keeps its NUL separators and every control byte, because the caller
	 * that renders it decides how — `policy_event` escapes losslessly, and
	 * union.c's `tr()` flattens to spaces for a trace nothing parses argv
	 * out of. Two readers for one fact is how they come to disagree, so
	 * there is one, and the RENDERING is what differs. */
	int                (*comm)(pid_t, char *, size_t);
	int                (*cmdline)(pid_t, char *, size_t);
};

static inline unsigned long long policy_real_starttime(pid_t pid);
static inline pid_t              policy_real_tgid(pid_t pid);
static inline int                policy_real_comm(pid_t, char *, size_t);
static inline int                policy_real_cmdline(pid_t, char *, size_t);

static struct proc_reader policy_proc = {
	policy_real_starttime, policy_real_tgid, policy_real_comm, policy_real_cmdline
};

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

/* ENOENT IS THE PROCESS BEING GONE and everything else is a failure to read it,
 * and the two are separated here rather than at the caller: only this function
 * knows which syscall failed. */
static inline int policy_real_comm(pid_t pid, char *out, size_t n)
{
	char buf[64];
	size_t len;
	FILE *f;

	if (n == 0)
		return POLICY_PROC_UNREADABLE;
	out[0] = '\0';
	snprintf(buf, sizeof(buf), "/proc/%d/comm", (int)pid);
	if (!(f = fopen(buf, "r")))
		return errno == ENOENT ? POLICY_PROC_GONE : POLICY_PROC_UNREADABLE;
	if (!fgets(out, (int)n, f)) {
		fclose(f);
		return 0;                       /* readable and empty */
	}
	fclose(f);
	len = strlen(out);
	while (len > 0 && (out[len - 1] == '\n' || out[len - 1] == '\r'))
		out[--len] = '\0';
	return (int)len;
}

/*
 * THE COLUMN THAT ACTUALLY ATTRIBUTES AN OP. `exe` is the INTERPRETER for
 * anything script-shaped — a PreToolUse hook and the Bash forwarder are both
 * /bin/bash — so the script's own path is in the cmdline and nowhere else.
 *
 * RAW, NUL SEPARATORS AND ALL. The separator IS the argv boundary, so a reader
 * that flattened it here would destroy the one thing the field is for. `n - 1`
 * so the result is also usable as a C string; the count is what carries the
 * embedded NULs.
 */
static inline int policy_real_cmdline(pid_t pid, char *out, size_t n)
{
	char buf[64];
	ssize_t k;
	int f;

	if (n == 0)
		return POLICY_PROC_UNREADABLE;
	out[0] = '\0';
	snprintf(buf, sizeof(buf), "/proc/%d/cmdline", (int)pid);
	if ((f = open(buf, O_RDONLY)) == -1)
		return errno == ENOENT ? POLICY_PROC_GONE : POLICY_PROC_UNREADABLE;
	k = read(f, out, n - 1);
	close(f);
	if (k < 0)
		return POLICY_PROC_UNREADABLE;
	out[k] = '\0';
	return (int)k;
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
 * WHAT MAKES IT SAFE IS THE MARK CHECK IN FRONT OF IT, NOT THE KEY. `mark_of`
 * re-reads /proc field 22 on every call and evicts a thread group whose start
 * time has moved, so it is the only thing in this file that can tell a marked
 * process from the pid that replaced it — and it touches no cache entry when it
 * does. A lookup placed ahead of it therefore serves a recycled tgid the mark
 * it no longer holds, which is criterion 6 defeated by a cache. The mark check
 * runs first, unconditionally, on every op.
 *
 * WHAT THE HIT THEN SAVES IS THE CONTROL ROUND TRIP, which is the expensive
 * half; the /proc read the mark check costs was never what the cache was for.
 *
 * THE tgid STAYS IN THE KEY, and what it buys is narrower than it looks: past
 * the mark check every caller that reaches the lookup is marked, and cc's
 * handler is caller-blind, so two marked callers get the same answer anyway.
 * It keeps an entry from outliving the thread group it was resolved for, and it
 * costs one hash mix. It is NOT what stops an unmarked caller being served.
 *
 * FILLED ONLY FOR MARKED CALLERS, for the same reason: an unmarked caller's
 * denial is never written back, so the mark's arrival is visible on the next op
 * rather than one TTL later.
 *
 * FETCH NEVER CONSULTS IT — an open always reaches cc, so no cached routing
 * decision can stand in for the materialisation an open needs. What that buys
 * is that S3's per-open revalidate inherits a contract with no cache in front
 * of it, rather than a one-second-stale one.
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

/*
 * THE FLAGS BYTE IS OP-SCOPED. Each bit is meaningful for exactly one op, and
 * naming which is part of the definition — the byte is one field, not a set of
 * independent booleans that every op must answer.
 *
 * They exist because CC CANNOT TELL THE WORKER'S INTENT FROM ITS OWN CACHE
 * MANAGEMENT. The mirror is both a cache cc creates, truncates and removes at
 * will AND the statement of what the worker did, and those two roles are in
 * direct conflict: a mirror entry that is gone may mean "the worker deleted it"
 * or "cc removed a stale copy", and cc was inferring the first from the second.
 * The bits below make the worker's intent DECLARED instead. The count is
 * deliberately not written into this prose, because the table is the list.
 */
#define CCU_FLAG_FOR_CREATE 0x01  /* FETCH: the caller is about to CREATE `path`,
                                   * so the PARENT is what must exist. */
#define CCU_FLAG_FOR_WRITE  0x02  /* "the worker is still writing here", and it
                                   * means that on BOTH ops it is defined for.
                                   * FETCH: take the claim — cc stops managing
                                   * `path` as a cache (no re-shape, no
                                   * truncate, no unmirror, no re-copy).
                                   * DIRTY: KEEP it — the handle is still open,
                                   * so reconcile but do not release. `flush`
                                   * fires once per `close` of a duplicated
                                   * descriptor while the original stays open,
                                   * and a claim released there would leave the
                                   * next write batch unprotected. */
#define CCU_FLAG_REMOVED    0x04  /* DIRTY: the worker REMOVED the entry, so the
                                   * source must lose it. Absence is never
                                   * inferred from the mirror; it is declared
                                   * here or it did not happen. */
#define CCU_FLAG_RELEASE_ONLY 0x08 /* DIRTY: release the claim and reconcile
                                   * NOTHING.
                                   *
                                   * TWO PRODUCERS, and the bit means the same
                                   * thing for both. `pt_release`: the handle is
                                   * closing and a `flush` already landed its
                                   * bytes, so the releasing frame has nothing
                                   * left to carry — without it every written
                                   * file uploads TWICE, once at `flush` and
                                   * once at `release`, because the releasing
                                   * frame is also a reconciling one
                                   * (PROVENANCE D13d). `policy_abandon_claim`
                                   * below: the op failed BEFORE mutating, so
                                   * the mirror still holds cc's own unmodified
                                   * cache copy and there is nothing to carry
                                   * either (PROVENANCE D16).
                                   *
                                   * A DEDICATED BIT, NOT A FLAG COMBINATION:
                                   * one bit, one meaning, on one op, which is
                                   * the discipline this table already states.
                                   * Encoding it as the absence of the other
                                   * bits would make the wire unreadable. */

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

/* ── the policy event log ───────────────────────────────────────────────── */
/*
 * THE INSTRUMENT THE PIN LIST IS DERIVED FROM, and the thing whose `deny` rows
 * must be empty by the end. Every fail-closed path, every REFUSED reply, every
 * unmarked denial AND every op this daemon served some way OTHER than the way
 * the tier table said, deduplicated on (path, reason, tgid) so a demand-paged
 * 215 MB binary cannot bury the one line that matters. PATHS ONLY, never content: a
 * credential path may appear in it and a credential never does.
 *
 * IT IS NOT A REFUSAL LOG, AND CALLING IT ONE WAS A FALSE CLAIM RATHER THAN A
 * naming preference. `self-recursion` returns 0 with `host_fd` — the op
 * SUCCEEDS — and `pinned-children-truncated` drops a name from a readdir that
 * also succeeds, so two non-denials already sat in a file called
 * `refusals.log`. Every reader's filter then had to enumerate reason strings by
 * hand to exclude them, which is the hand-maintained enumeration this epic
 * keeps being bitten by. THE KIND IS THE FIRST COLUMN so a filter derives from
 * it instead.
 *
 * EXACTLY TWO KINDS, and the boundary is "did the caller get an error":
 *   EV_DENY    the op was refused — the caller has a negative errno.
 *   EV_SERVED  the op succeeded, but not the way the tier table said.
 *
 * A THIRD KIND WOULD BREAK `R4`, whose whole filter is `kind == deny`.
 */
enum ev_kind { EV_DENY = 0, EV_SERVED };

static inline const char *ev_kind_name(enum ev_kind k)
{
	switch (k) {
	case EV_SERVED: return "served";
	case EV_DENY:   break;
	}
	return "deny";
}

/*
 * ONE ESCAPER FOR EVERY FIELD THAT CAN CARRY AN ARBITRARY BYTE — the path, the
 * comm and the cmdline. The row is TAB-SEPARATED and NEWLINE-TERMINATED, so a
 * field holding either destroys it: the instrument this daemon was forked from
 * produced 1662 unparsable rows out of ~3000 because `/proc/<pid>/cmdline` is
 * NUL-separated and a `bash -c` argv carries the whole script, newlines
 * included, and the analysis silently dropped them. The path is escaped by the
 * same function rather than by a second rule — a path may contain a tab today.
 *
 *   \\ → \\\\          the escape character itself, HANDLED FIRST: escaping the
 *                    tab first would make a literal `\` followed by `t` decode
 *                    back as a tab.
 *   \t \n \r        the three bytes that split a row or a field
 *   NUL → \0        the argv separator, which is what makes `argv` recoverable
 *   other < 0x20,
 *   0x7f            \xHH, lowercase
 *   0x80–0xff       VERBATIM, so a UTF-8 path stays readable and still cannot
 *                   break a tab/line parse
 *
 * `\` IS NEVER FOLLOWED BY `!` in any output above, which is what makes `\!` a
 * free sentinel namespace for the recorded absences below — unforgeable by
 * construction rather than by hoping no argv spells one.
 *
 * `len` IS COUNTED, NEVER strlen'd: a cmdline's NULs are content.
 * Returns 1 if the whole input fit, 0 if it was cut short (terminated either
 * way, so the caller can append its own marker).
 */
static inline int policy_escape(char *dst, size_t cap, const char *src, size_t len)
{
	static const char hex[] = "0123456789abcdef";
	size_t o = 0, i;

	if (cap == 0)
		return 0;
	for (i = 0; i < len; i++) {
		unsigned char c = (unsigned char)src[i];
		char esc[4];
		size_t w;

		if      (c == '\\') { esc[0] = '\\'; esc[1] = '\\'; w = 2; }
		else if (c == '\t') { esc[0] = '\\'; esc[1] = 't';  w = 2; }
		else if (c == '\n') { esc[0] = '\\'; esc[1] = 'n';  w = 2; }
		else if (c == '\r') { esc[0] = '\\'; esc[1] = 'r';  w = 2; }
		else if (c == '\0') { esc[0] = '\\'; esc[1] = '0';  w = 2; }
		else if (c < 0x20 || c == 0x7f) {
			esc[0] = '\\'; esc[1] = 'x';
			esc[2] = hex[c >> 4]; esc[3] = hex[c & 0xf]; w = 4;
		} else { esc[0] = (char)c; w = 1; }
		if (o + w >= cap) { dst[o] = '\0'; return 0; }
		memcpy(dst + o, esc, w);
		o += w;
	}
	dst[o] = '\0';
	return 1;
}

/*
 * AN ABSENT FIELD IS RECORDED, NEVER INFERRED, AND NEVER LOOKS LIKE A VALUE.
 *
 *   \!gone         the /proc entry was not there — the process exited between
 *                  the op and the sample
 *   \!unreadable   it was there and could not be read
 *   \!empty        the read succeeded and returned nothing (a kernel thread,
 *                  or a zombie)
 *   \!truncated    a SUFFIX on an otherwise-valid encoded field that hit the
 *                  cap, so a reader gets "argv-so-far, truncated" rather than
 *                  a short argv it would read as complete
 *
 * `capped` is the caller's "the reader filled its buffer", which the encoder
 * cannot see; a field too long to ENCODE is marked by the same suffix.
 */
#define POLICY_TRUNC_SUFFIX "\\!truncated"

static inline void policy_event_field(char *dst, size_t cap, const char *raw,
				      int n, int capped)
{
	size_t room;

	if (n == POLICY_PROC_GONE) { memcpy(dst, "\\!gone", sizeof("\\!gone")); return; }
	if (n < 0)  { memcpy(dst, "\\!unreadable", sizeof("\\!unreadable")); return; }
	if (n == 0) { memcpy(dst, "\\!empty", sizeof("\\!empty")); return; }
	room = cap - sizeof(POLICY_TRUNC_SUFFIX) + 1;
	if (!policy_escape(dst, room, raw, (size_t)n) || capped)
		memcpy(dst + strlen(dst), POLICY_TRUNC_SUFFIX, sizeof(POLICY_TRUNC_SUFFIX));
}

/* A field's worst case is four bytes out per byte in (`\xHH`), plus the
 * terminator and the truncation suffix. */
#define POLICY_ESC_CAP(n) ((n) * 4 + sizeof(POLICY_TRUNC_SUFFIX) + 1)

static FILE           *event_fp = NULL;
static pthread_mutex_t event_mu = PTHREAD_MUTEX_INITIALIZER;

#define EVENT_SLOTS 65536
static char  *event_seen[EVENT_SLOTS];
static size_t event_n = 0;

/* caller holds event_mu */
static inline int event_dup(const char *key)
{
	size_t slot, i;

	if (event_n >= EVENT_SLOTS / 2)
		return 0;                       /* full: stop deduping, keep logging */
	slot = policy_strhash(key) % EVENT_SLOTS;
	for (i = 0; i < EVENT_SLOTS; i++) {
		char **e = &event_seen[(slot + i) % EVENT_SLOTS];
		if (!*e) { *e = strdup(key); event_n++; return 0; }
		if (strcmp(*e, key) == 0) return 1;
	}
	return 0;
}

/*
 * THE DEDUPE KEY IS (path, reason, tgid), AND THE TGID IS IN IT BECAUSE
 * ATTRIBUTION IS THE POINT OF THE ROW (card 2026-0389).
 *
 * Without it the key is (path, reason) and the FIRST caller to reach a path
 * wins the row while every later one is silently dropped — so the identity
 * columns would answer "who asked?" with "whoever happened to be first", which
 * is worse than not answering. Volume stays bounded, by distinct (path × thread
 * group); `event_dup` already degrades gracefully past EVENT_SLOTS/2.
 *
 * THE KIND IS STILL OUT, AND THAT CHOICE IS UNOBSERVABLE rather than
 * load-bearing. The kind is a FUNCTION of the reason: every reason maps to
 * exactly one kind, derived from every `policy_event(` call site in both C
 * sources and set-compared in both directions by
 * `tests/fuse-union-policy.test.mjs`. So on any emission this daemon can
 * produce the two keys partition identically, and adding the kind could only
 * split a row that is already unique. WHAT THAT COSTS, NAMED: a defect emitting
 * one reason under BOTH kinds would collapse to a single row rather than
 * showing two — acceptable only because the one-kind-per-reason property is
 * checked AT THE CALL SITES, where it is decidable from the source.
 *
 * `tid` IS THE CALLING THREAD — union.c hands every site
 * `fuse_get_context()->pid`, which S1 measured to be a TID. BOTH ids are
 * logged, because neither substitutes for the other: the TID is what the trace
 * keys on, and the TGID is what the mark, the resolution cache and this key are
 * on. `comm` and `cmdline` are read from the THREAD GROUP, matching
 * `resolve_ids`.
 *
 * IDENTITY IS SAMPLED AT POLICY TIME, AFTER THE DECISION AND AFTER THE DEDUPE.
 * It cannot change any answer — there is no error return and no branch on it —
 * and the two /proc reads it costs — comm and cmdline — are paid once per
 * DISTINCT ROW rather than once per op. The TGID read is NOT: the dedupe key
 * needs it, so it happens on every call, and it is the same read `mark_of` and
 * `policy_project_route` already make. `exec(2)`
 * replaces comm and cmdline while leaving pid, tgid and start time untouched,
 * so no validation can make the sample authoritative for the op that triggered
 * it; the header line written by `main()` says so in the file itself.
 */
static inline void policy_event(enum ev_kind kind, const char *op,
				const char *path, const char *reason, pid_t tid)
{
	char key[PATH_MAX + 96];
	char rawcomm[64], rawcmd[POLICY_CMDLINE_MAX];
	char epath[POLICY_ESC_CAP(PATH_MAX)];
	char ecomm[POLICY_ESC_CAP(sizeof(rawcomm))];
	char ecmd[POLICY_ESC_CAP(sizeof(rawcmd))];
	pid_t tgid;
	int cn, mn;

	if (!event_fp)
		return;
	tgid = policy_proc.tgid(tid);
	snprintf(key, sizeof(key), "%s\t%s\t%d", path, reason, (int)tgid);
	pthread_mutex_lock(&event_mu);
	if (!event_dup(key)) {
		mn = policy_proc.comm(tgid, rawcomm, sizeof(rawcomm));
		cn = policy_proc.cmdline(tgid, rawcmd, sizeof(rawcmd));
		/* `epath` cannot overflow — a path is PATH_MAX-bounded and the
		 * buffer holds the worst-case encoding of one. */
		policy_escape(epath, sizeof(epath), path, strlen(path));
		policy_event_field(ecomm, sizeof(ecomm), rawcomm, mn, 0);
		policy_event_field(ecmd, sizeof(ecmd), rawcmd, cn,
				   cn == (int)sizeof(rawcmd) - 1);
		fprintf(event_fp, "%s\t%s\t%s\t%s\t%d\t%d\t%s\t%s\n",
			ev_kind_name(kind), op, epath, reason,
			(int)tid, (int)tgid, ecomm, ecmd);
	}
	pthread_mutex_unlock(&event_mu);
}

/*
 * RELEASE THE WRITE CLAIM FOR AN OP THAT TOOK ONE AND THEN FAILED.
 *
 * A `FETCH` carrying CCU_FLAG_FOR_WRITE turns cc's cache OFF for that path
 * until a `DIRTY` arrives. If the op then fails — `openat` refused, the
 * mutation returned -1, a refusal after the claim — no DIRTY would ever come
 * and the path would stay uncached for the life of the session, with cc
 * declining to refresh a mirror copy it is still serving reads from and
 * answering ABSENT for a file the source may since have gained.
 *
 * Lives here rather than in union.c because it composes only the primitives
 * above — a tier test, the cache and the transport — so it is drivable from a
 * unit fixture. It was previously in the op bodies and had no behavioural
 * coverage at all.
 *
 * IT CARRIES CCU_FLAG_RELEASE_ONLY, AND THAT BIT IS THE WHOLE OF WHAT AN
 * ABANDON MEANS: release the claim, reconcile NOTHING. The op failed before
 * mutating, so the mirror still holds cc's own unmodified cache copy and there
 * is nothing to carry.
 *
 * A BARE ZERO WAS A REAL DEFECT, not a tidiness question, and it is recorded
 * because the two frames are otherwise identical on the wire. `pt_release`
 * sends a flagless DIRTY for a handle that WROTE and never flushed — the
 * killed-process backstop — so cc read an abandon as exactly that: it pushed
 * the mirror's unmodified copy and, if the push failed, recorded a `diverged`
 * fault whose sentence asserts a write that never happened and kept the claim
 * for the session, freezing cc's cache on a file the worker never touched. The
 * pre-fault behaviour self-healed on the next FETCH; the fault removed that.
 * cc cannot separate the two by inspection — same op, same flags, same
 * `createdHere` — so the DAEMON DECLARES WHICH IT IS, which is what the
 * op-scoped flags byte exists for.
 *
 * It therefore also drops one whole-file upload from every error path.
 *
 * THE RESULT IS DELIBERATELY DISCARDED: the caller already has an errno to
 * report, and replacing it with the reconcile's would tell the worker the wrong
 * thing.
 *
 * NOTHING HAPPENS AT ANY OTHER TIER, because no other tier takes a claim: a
 * frame is sent only for T_PROJECT.
 */
static inline void policy_abandon_claim(const char *path, enum tier tier)
{
	if (tier != T_PROJECT)
		return;
	cache_invalidate(path);
	(void)ccu_call(CCU_DIRTY, CCU_FLAG_RELEASE_ONLY, path);
}

/* ── the caller-sensitive tiers ─────────────────────────────────────────── */
/*
 * THE HOST ROOT, AS AN O_PATH fd. ONE VARIABLE FOR ONE fd, and the placement is
 * the point: the host-existence probe below and union.c's T_HOST arm must open
 * the SAME descriptor through the SAME relativiser, or the probe can answer for
 * a path the arm would not serve. `union.c` used to declare its own `host_fd`
 * and its own `rel()`; two spellings for one thing is exactly the drift that
 * file's comments warn about, so both live here — where the unit fixture can
 * also drive them, the way it drives `policy_proc`, `policy_clock` and
 * `ccu_xport`.
 *
 * NEGATIVE UNTIL `main()` OPENS IT, and `policy_host_absent` answers 1 on a
 * negative fd — "no host at all", which is the axis the unit fixture uses to
 * drive "the orchestrator has nothing". The polarity is stated here because the
 * DELETED `policy_host_has` answered 0 in the same situation, and a reader
 * carrying that direction across would invert every overlay decision.
 */
static int policy_host_fd = -1;

/* A UNION PATH RELATIVE TO THE HOST ROOT. Absolute paths arrive from libfuse
 * with a leading `/`; `openat`/`fstatat` want them relative to the fd, and the
 * root itself has to become `.` rather than the empty string. */
static inline const char *policy_rel(const char *path)
{
	if (path[0] == '/' && path[1] == '\0')
		return ".";
	return path + 1;
}

/*
 * IS THE HOST DEFINITELY WITHOUT AN ENTRY AT `path`? ONE fstatat, THROUGH THE
 * SAME fd AND THE SAME relativiser THE T_HOST ARM WOULD OPEN — which is what
 * makes a second spelling structurally impossible rather than merely absent.
 *
 * DEFINITE ABSENCE ONLY, AND THAT IS THE INVERSE POLARITY OF THE DELETED
 * `policy_host_has` — which is why that function is gone rather than reused at a
 * new call site. Reusing it would have picked the wrong failure direction
 * SILENTLY, and this probe's failure direction is the whole of its risk.
 *
 * AT_SYMLINK_NOFOLLOW, matching pt_getattr's own T_HOST arm: a dangling host
 * symlink IS a host entry, so it is not an absence and no node is synthesized
 * over it. Following instead would overlay a path the host names.
 *
 * PROBED AS ROOT — no cred_enter/cred_leave — so the CLASSIFICATION does not
 * vary with the caller's uid; permission is still enforced by the host op that
 * follows. EACCES is therefore unreachable here, exactly as it was for the
 * deleted probe.
 *
 * A NEGATIVE fd ANSWERS 1 — "no host at all", the axis the unit fixture drives
 * by leaving the seam unset.
 *
 * THE FAILURE DIRECTION, STATED AND CHOSEN RATHER THAN LEFT TO FALL OUT. On any
 * failure that is not an absence errno — ELOOP from an intermediate symlink
 * (AT_SYMLINK_NOFOLLOW spares only the FINAL component), EIO, NFS under
 * root_squash, a permission-enforcing FUSE beneath us — this answers NOT ABSENT,
 * so NO node is synthesized. Which constraint that sacrifices, and why it is the
 * right one:
 *
 *   Falling ABSENT on an unknown error would place a 0555 traverse-only node
 *   over a directory the orchestrator may really have, hiding it and its write
 *   surface — violating constraints 1 and 2 SILENTLY, with an unmarked caller
 *   quietly unable to see or write a host directory that exists. That is the
 *   exact failure class card 2026-0398 took a day to diagnose.
 *
 *   Falling NOT ABSENT lets the path fall to `fail -> host`, where the host
 *   answers for itself. If the orchestrator genuinely has nothing there, `chdir`
 *   fails with the host's own errno and an event row names the path — violating
 *   constraint 4 at that ONE path, LOUDLY and diagnosably, and degrading to
 *   exactly this path's behaviour before the card.
 *
 * Loud and reversible beats silent and hiding.
 */
static inline int policy_host_absent(const char *path)
{
	struct stat st;

	if (policy_host_fd < 0)
		return 1;               /* the fixture's "no host at all" axis */
	if (fstatat(policy_host_fd, policy_rel(path), &st, AT_SYMLINK_NOFOLLOW) == 0)
		return 0;
	return errno == ENOENT || errno == ENOTDIR || errno == ENAMETOOLONG;
}

/* ── the floor ──────────────────────────────────────────────────────────── */
/*
 * THE ONLY MUTATION OF A HOST STAT THIS DAEMON MAKES: a cwd-chain directory the
 * orchestrator HAS is reported to an unmarked caller with its `--x` bits set, so
 * the kernel — which decides traversal from the mode the union reports, because
 * the mount carries `default_permissions` — lets the walk through. Without it a
 * `drwx------ root root` link kills every spawn in chdir() before execve.
 *
 * SCOPED TO THE CWD CHAIN, AND THE SCOPE IS WHAT MAKES CONSTRAINT 1 MORE
 * EXACTLY SATISFIED, NOT LESS: everything else keeps its real mode, where an
 * unscoped floor would grant traversal the host itself denies.
 *
 * THE RESIDUAL IS IRREDUCIBLE AND IS NAMED RATHER THAN PAPERED OVER: a floored
 * 0700 directory advertises a traversal its CONTENTS then refuse — `stat /root`
 * says traversable, `stat /root/secret` says EACCES, because the daemon's own op
 * runs under cred_enter against the real mode. It cannot be closed. `cred_enter`
 * is mandatory (S1 §7.2 measured the CLI's Bash tool failing outright without
 * it), and permitting the walk REQUIRES reporting `x`. The floor grants PATH
 * RESOLUTION ONLY, NEVER ACCESS: everything under such a directory stays refused
 * by the real filesystem, and the chain itself works because the next component
 * is either also floored or is the overlay node, which touches no host.
 *
 * TWO ENTRY POINTS OVER ONE PREDICATE, and the split is mechanical rather than a
 * second rule: three of the four reporting ops hold a `struct stat` and
 * `pt_access` holds a mask. A source-shape assertion in
 * tests/fuse-union-policy.test.mjs enumerates both across exactly four op bodies
 * and nowhere else — apply it at fewer and the floor becomes a seam inside the
 * seam it exists to close, with `stat` and `test -x` disagreeing from one
 * caller.
 */
static inline int policy_floor_applies(const char *path, mode_t mode, enum view v)
{
	return v == VIEW_HOST && S_ISDIR(mode) && policy_cwd_component(path);
}

static inline void policy_floor_traversal(const char *path, struct stat *st, enum view v)
{
	if (policy_floor_applies(path, st->st_mode, v))
		st->st_mode |= 0111;
}

/*
 * THE FLOOR AS `pt_access` HAS TO ASK IT: the mask the real `faccessat` should
 * be given. X_OK is cleared where the floor applies, so an empty remainder means
 * "permitted" and the caller's `test -x` agrees with the `stat` it just made.
 *
 * THE MODE COMES FROM A ROOT-SIDE fstatat, gated behind the string compare for
 * the same reason the overlay's conjuncts are ordered — and probed as root for
 * the same reason `policy_host_absent` is: the CLASSIFICATION must not vary with
 * the caller's uid, and permission is still enforced by the `faccessat` that
 * follows. A probe that cannot answer leaves the mask untouched, which is the
 * pre-floor behaviour.
 */
static inline int policy_floor_mask(const char *path, int mask, enum view v)
{
	struct stat st;

	if (v != VIEW_HOST || !policy_cwd_component(path))
		return mask;
	if (policy_host_fd < 0)
		return mask;
	if (fstatat(policy_host_fd, policy_rel(path), &st, 0) != 0)
		return mask;
	if (!policy_floor_applies(path, st.st_mode, v))
		return mask;
	return mask & ~X_OK;
}

/*
 * THE TIER TABLE CLASSIFIES FOR EVERYONE; AN UNMARKED CALLER RESOLVES IT IN
 * `VIEW_HOST`. This predicate is not that rule — it is the cheap conservative
 * GATE on the /proc mark read, and naming it an optimisation rather than a rule
 * is load-bearing: a reader who takes it for the policy will look for the
 * behaviour in the wrong place. The set is exactly the tiers whose `VIEW_CLI`
 * answer CAN differ in `VIEW_HOST`, and the three are there for two reasons:
 *
 *   T_PROJECT  the `project` pins are struck in `VIEW_HOST`, so the answer moves
 *              to whatever shorter pin covers the path, or to `fail`.
 *   T_SYNTH    `VIEW_HOST` does not consult the ancestor table, so an
 *              ancestor-of-a-pin directory falls to `fail` there — and `fail`
 *              means host. Without this member nothing would ever ask, and an
 *              unmarked caller would keep meeting a 0555 scaffold node over a
 *              directory the orchestrator HAS: "a violation, not a rounding"
 *              (epic criterion 4). Added by the conductor ruling of 2026-09-11.
 *   T_FAIL     substituted to host UNCONDITIONALLY, and it may also become the
 *              OVERLAY node on the cwd chain.
 *
 * WHY THE OTHER THREE ARE NOT HERE, each for its own reason rather than by
 * omission: `hide` is what keeps the mirror and cc's control socket unreachable
 * and `VIEW_HOST` does not strike it; `bind` is resolved by UNMARKED `mount` for
 * /proc, /sys and /dev before the marking event ever fires, and is not struck
 * either, so both answer identically in both views; `host` already IS the host.
 *
 * WHY `fail` IS CALLER-SENSITIVE AT ALL. `fail` means "no pin covers this",
 * which is a statement about the CLI's PIN LIST — not about a caller that was
 * never going to be served the remote. Every shell, hook, forwarder and MCP
 * subprocess in the chroot is a fresh, permanently unmarked thread group, and
 * before this the pin list had to cover every object every one of them loads:
 * that is why `libtinfo.so.6` killed `bash` although marking never enters it.
 *
 * THE ENOENT AT THE FAR SIDE IS THE HOST'S OWN ANSWER, not a policy denial, and
 * that is the one thing the substitution costs: an unmarked caller's missing
 * object writes no `deny` row. So `policy_caller_tier` logs the SUBSTITUTION
 * itself — see below.
 *
 * KEPT HERE RATHER THAN INLINE IN route() so the set is drivable from the unit
 * fixture, where no kernel gate can mask it.
 */
static inline int policy_tier_is_caller_sensitive(enum tier t)
{
	return t == T_FAIL || t == T_PROJECT || t == T_SYNTH;
}

/*
 * AN UNMARKED CALLER RESOLVES IN `VIEW_HOST`, FULL STOP — that is the whole of
 * this function, and the two `if`s below are that sentence plus the `fail`
 * rule. The 2026-09-09 "host-entry existence is the discriminator" ruling and
 * the 2026-09-08 "an unmarked caller at the project path gets neither read nor
 * write" one are both PRESERVED and both now fall out of the view rather than
 * being tested for: the remote tier is not in the view, so the geometry cannot
 * be consulted, and where the orchestrator has an entry the host serves it.
 *
 * `op` AND `tid` STAY OUT OF THE DECISION, and keeping them out is a property to
 * preserve: an op-sensitive map would give `pt_rename`'s and `pt_link`'s two
 * routed paths different answers and manufacture an EXDEV that S2 §8 already
 * measured as a footgun (`mv` masks it, `rename(2)` does not). `tid` is NOT a
 * second mark check — the caller already resolved that into `marked`, and
 * re-deriving it here would give one function two answers for one caller.
 *
 * IT CAN NEVER RETURN T_PROJECT FOR AN UNMARKED CALLER, and that is now
 * STRUCTURAL rather than asserted: `resolve_class(path, VIEW_HOST)` cannot
 * produce it, because `tier_of` skips every `project` pin in that view.
 *
 * THE RE-RESOLUTION'S RANGE IS {T_HOST, T_SYNTH, T_FAIL, T_HIDE}, AND T_HIDE IS
 * NOT AN OVERSIGHT. Striking a `project` pin hands the longest-prefix contest to
 * whatever SHORTER pin covers the path, and a `hide` pin is eligible to win it —
 * so a path under a `hide` prefix with a LONGER `project` pin inside it is
 * T_PROJECT to the CLI and T_HIDE to everyone else. That is the correct answer:
 * `hide` is what keeps the mirror and cc's control socket unreachable, and
 * route()'s T_HIDE arm answers -ENOENT before anything else, so the tier is
 * carried through here unchanged rather than substituted. `b41` builds the
 * overlap deliberately and asserts all four — the three-member claim this
 * paragraph replaces was never met by a geometry that could contradict it.
 *
 * TWO REASONS, NOT ONE, and the `fail` row keeps its own: it feeds `suggestPin`,
 * which the substituted-project row correctly must not.
 *
 * THE ROW FIRES ON THE SUBSTITUTION, NOT ON THE OUTCOME of the host op that
 * follows — which is also all this function can know. It is `served` rather
 * than `deny` because the op was not refused. Volume is bounded by distinct
 * path × thread group (the log dedupes on (path, reason, tgid)).
 */
static inline enum tier policy_caller_tier(const char *op, const char *path,
					   enum tier t, int marked, pid_t tid)
{
	if (marked)
		return t;
	if (t == T_PROJECT || t == T_SYNTH)
		t = resolve_class(path, VIEW_HOST);   /* the remote tier is not yours */
	if (t == T_FAIL) {
		policy_event(EV_SERVED, op, path, "unmarked-host-served", tid);
		return T_HOST;
	}
	return t;             /* a shorter host/bind pin, or the overlay node */
}

/* ── the cwd chain ──────────────────────────────────────────────────────── */
/*
 * EACH COMPONENT OF THE CLI'S CWD IS MADE TRAVERSABLE FOR AN UNMARKED CALLER:
 * by the ORCHESTRATOR'S OWN DIRECTORY floored to `--x` where it has one, or by
 * the OVERLAY node where it has none. The chain is the whole domain of both, and
 * this section owns the predicate they share.
 *
 * WHY IT HAS TO EXIST. A spawn chdir()s into the CLI's cwd IN THE FORKED CHILD,
 * before it execs — so the caller is a new, unmarked thread group, and a denial
 * or an unsearchable directory kills the process before its own image runs.
 * Every child the CLI spawns at its own cwd died of this (card 2026-0373), and
 * under a `mirrorRoot` that is a strict ancestor of `systemPath` every one of
 * them died again at an intervening component (card 2026-0398).
 *
 * WHY IT IS THE WHOLE CHAIN AND NOT THE PROJECT ROOT ALONE (owner amendment,
 * 2026-09-08: "I'm fine with allowing the read of the full traversed cwd of the
 * remote. Just the directories. Not the files or the content of these remote
 * directories."). A chdir walks EVERY component.
 *
 * THE EXEMPTION THAT USED TO LIVE HERE IS GONE, AND WITH IT `T_CWD`, the op
 * allow-list and the 0111 node (card 2026-0398). There is no conditional grant
 * any more: an unmarked caller simply resolves in `VIEW_HOST`, where the chain
 * is answered by the host itself or by the overlay. What survives is this
 * section's three subjects — the injected cwd, the component predicate and the
 * chain's inode sub-range — each with a new role and none with a new rule.
 */

/* THE CWD, INJECTED ONCE, COMPARED PER OP. Same shape as `mark_path`: one
 * string, no derived table, so NOTHING CAN GO STALE when the cwd changes —
 * there is no component list to leave behind.
 *
 * IT LIVES HERE AND NOT IN union.c, AND THAT IS A DESIGN REQUIREMENT. The unit
 * fixture compiles policy.h alone and assigns this directly as a seam, the way
 * it assigns `policy_proc`, `policy_clock` and `ccu_xport`; a variable in
 * union.c is undrivable, which is exactly why `mark_path`'s own event is
 * COVERED NOWHERE. Do not repeat that placement.
 *
 * NULL IS FAIL-CLOSED AND union.c REFUSES TO MOUNT ON IT: with no cwd the chain
 * is empty, so nothing is floored and no overlay node exists — every spawn dies
 * in chdir() exactly as it did before 2026-0373, while the mount looks healthy.
 * `main()` refuses, alongside CC_UNION_MARK_PATH and CC_UNION_CONTROL and for
 * the same class of reason — one input enables the project tier at all, this one
 * enables entry to it. */
static const char *cwd_path = NULL;

/*
 * `path` IS AN ANCESTOR-OR-EQUAL OF THE CWD, AT A COMPONENT BOUNDARY — "/", the
 * cwd itself, or any directory between them. Never a sibling, never a child.
 *
 * THE BOUNDARY CHECK IS NOT DEFENSIVE TIDINESS: it is the C spelling of the
 * rule `withinPosix` (src/systems/mirror.ts) keeps by going through
 * `path.posix.relative` rather than a string prefix, so that `/app-backup` is
 * not inside `/app`. The trap is identical here in the other direction — for a
 * cwd of `/root/app3` the candidate `/root/app` IS a string prefix, and a bare
 * strncmp would put a directory on the chain that is not on it at all — which
 * would floor it, or hang an overlay node off it. C has no
 * path.posix.relative, so this is that rule.
 *
 * BOTH DIRECTIONS OF THE SIBLING TRAP ARE REJECTED, BY DIFFERENT MECHANICS, and
 * a case that exercises one proves half the guard: `path = /root/app` against
 * `cwd = /root/app3` is rejected by `cwd_path[9] == '3'`; `path = /root/app3`
 * against `cwd = /root/app` is rejected by `strncmp` itself, which meets
 * `cwd`'s '\0' against '3'. `b22` drives both.
 */
static inline int policy_cwd_component(const char *path)
{
	size_t len;

	if (!cwd_path || path[0] != '/')
		return 0;
	if (path[1] == '\0')
		/* "/" — every absolute cwd's first component, and the one case
		 * the boundary test below cannot express. */
		return 1;
	len = strlen(path);
	return strncmp(cwd_path, path, len) == 0
	    && (cwd_path[len] == '/' || cwd_path[len] == '\0');
}

/*
 * THE CWD NODE'S INODE, IN ITS OWN SUB-RANGE, KEYED ON THE COMPONENT'S POSITION
 * IN THE CHAIN — which is ordered, bounded by PATH_MAX, and derived rather than
 * tabulated.
 *
 * NOT `policy_bind_ino`, AND THAT IS THE MOST LIKELY WAY THIS WIDENING GOES
 * QUIETLY WRONG. `policy_bind_ino` scans for an EXACT pin and returns ONE
 * shared fallback for anything unpinned — its own comment states the assumption
 * it loses here ("Neither is in the ancestor set (both carry an exact pin)").
 * A widened chain covers intermediate components that have NO exact pin, so
 * every one of them would report the same st_ino.
 *
 * WHAT OBSERVES IT, because the justification has to be something that fires:
 *   1. `use_ino = 1` is this daemon's OWN stated invariant (pt_init: "A union
 *      must not invent st_ino… synthetic nodes supply their own from the
 *      ancestor table, in a range no real filesystem here hands out"). Distinct
 *      nodes get distinct inodes is a contract this file already makes.
 *   2. `test -ef` compares (st_dev, st_ino) and needs only two `stat` calls and
 *      no readdir — measured — so it is REACHABLE under this ruling. Under a
 *      collision `[ /root -ef /root/app3 ]` would answer TRUE, which is false.
 *
 * NOT `getcwd`, and that correction is recorded so nobody re-derives the wrong
 * reason: measured on glibc 2.41, `getcwd(2)` answers from the dentry cache and
 * emits no getdents at all, and `chdir(2)` compares no inodes — so glibc's
 * userspace (dev, ino) fallback is never reached. (If `getcwd(2)` ever DID fail
 * it would need to readdir each parent, which this ruling denies; no inode
 * scheme fixes that, and it is an accepted limit of a traverse-only node.)
 *
 * DISJOINT FROM BOTH NEIGHBOURING RANGES, and the `npins` term is what makes
 * the second half true: ancestors take SYNTH_INO_BASE + idx (idx < MAX_ANC),
 * exact pins take SYNTH_INO_BASE + MAX_ANC + i (i < npins), and the chain
 * starts past both. Three sub-ranges over one base is exactly the arithmetic
 * that silently overlaps after an edit, so `b27` pins the disjointness.
 */
static inline unsigned long long policy_cwd_ino(const char *path)
{
	unsigned long long depth = 0;
	const char *c;

	/* The component's DEPTH: 0 for "/", else one per '/'. Distinct per
	 * component of one chain by construction — a chain has exactly one
	 * component at each depth. */
	if (path[1] != '\0')
		for (c = path; *c; c++)
			if (*c == '/')
				depth++;
	return SYNTH_INO_BASE + MAX_ANC + (unsigned long long)npins + depth;
}

/*
 * CC_UNION_CWD IS REFUSED WHEN IT IS NOT NORMALISED, NEVER NORMALISED HERE.
 * Three reasons and the third decides it: normalising means writing a path
 * canonicaliser in C, which is new code with its own bugs; `..` cannot be
 * resolved correctly without touching the filesystem, because a component may
 * be a symlink; and CC OWNS THE INPUT — `plan.cwdInside` is already absolute,
 * so a non-normalised value is a cc DEFECT and the right response is a loud
 * refusal. `buildFusePlan` asserts the same thing at configuration time, where
 * the failure is legible.
 *
 * A DOUBLED SLASH — OR A `.`/`..` COMPONENT — IS THE CASE THAT BITES, and it
 * bites at the LAST component: `cwd = /root//app3` matches `/` and `/root` and
 * then fails on the cwd ITSELF, so a chdir walks the whole chain and dies at
 * its destination. A TRAILING slash, by contrast, still matches everything —
 * the boundary test reads it as the separator it wants — so that half of the
 * predicate buys no behavioural rescue and is here purely because a
 * non-normalised input is a cc defect. `b28` asserts both, and asserted the
 * trailing-slash claim down from the stronger one first stated here.
 */
static inline int policy_cwd_normalised(const char *p)
{
	const char *c;

	if (!p || p[0] != '/')
		return 0;
	if (p[1] == '\0')
		return 1;                       /* "/" is normalised */
	/* A TRAILING SLASH — AND THIS CLAUSE IS REDUNDANT *HERE*, DELIBERATELY
	 * KEPT, AND LOAD-BEARING ONE LAYER UP. Measured by mutation: deleting it
	 * leaves the whole suite green, because a trailing slash always leaves an
	 * EMPTY FINAL COMPONENT and the loop below refuses that at `end == c`.
	 * It stays because it names the shape a reader is looking for, and it is
	 * one comparison.
	 *
	 * DO NOT CARRY THE REDUNDANCY ACROSS TO `buildFusePlan`, WHERE THE SAME
	 * CONCEPTUAL CHECK IS THE ONLY THING REFUSING THIS SHAPE. Its predicate is
	 * `endsWith('/') || includes('//') || split('/').some(c => c === '.' ||
	 * c === '..')` — and for `/srv/app/` the split's empty final component is
	 * neither `.` nor `..` and there is no `//`, so dropping `endsWith` there
	 * makes cc ACCEPT a trailing slash. The prover measured that mutant killed
	 * by two tests. Same idea, opposite status, because the two predicates
	 * enumerate components differently. */
	if (p[strlen(p) - 1] == '/')
		return 0;
	for (c = p; *c; ) {
		const char *end;

		c++;                            /* past the '/' */
		end = strchr(c, '/');
		if (!end)
			end = c + strlen(c);
		if (end == c)
			return 0;                       /* "//" */
		if ((end - c == 1 && c[0] == '.') ||
		    (end - c == 2 && c[0] == '.' && c[1] == '.'))
			return 0;                       /* "." or ".." */
		c = end;
	}
	return 1;
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
 *  2. THE MARK — RETAINED AS DEFENCE IN DEPTH, AND NO LONGER THE LIVE
 *     MECHANISM. Since card 2026-0398 an UNMARKED caller cannot reach here at
 *     all: it resolves in `VIEW_HOST`, where `tier_of` skips every `project`
 *     pin, so no unmarked resolution can produce T_PROJECT and route() cannot
 *     dispatch one to this function. The invariant it used to enforce — an
 *     unmarked caller never receives remote file content — is now a property of
 *     the VIEW, which is structural.
 *
 *     IT STAYS ANYWAY, AND DELIBERATELY. This is a liveness guard on the only
 *     path that sends a control frame; deleting it on the strength of a
 *     structural proof is not worth the risk, and its -ENOENT is the correct
 *     answer if a later edit ever reopens the route. `b7` pins it under that
 *     reading.
 *  3. THE CONTROL CALL. A bare local stat of the mirror would report ENOENT for
 *     a file that exists on the remote and has simply not been materialised
 *     yet, so no remote-tier op touches the mirror before cc has answered.
 */
static inline int policy_project_route(const char *op, const char *path, pid_t tid,
                                       uint8_t fop, uint8_t flags)
{
	pid_t tgid = policy_proc.tgid(tid);
	int cached = 0, rc;

	/*
	 * FIRST, AND ON EVERY OP. `mark_of` re-reads field 22 and evicts a thread
	 * group whose start time has moved, so this is the only step that can
	 * tell the marked process from the pid that replaced it. Behind a cache
	 * lookup it would be skipped on a hit and a recycled tgid would be served
	 * the mark it no longer holds.
	 */
	if (!mark_of(tgid)) {
		policy_event(EV_DENY, op, path, "unmarked-project-denied", tid);
		return -ENOENT;
	}

	if (fop != (uint8_t)CCU_FETCH && cache_get(tgid, path, &cached))
		return cached;

	rc = fop ? ccu_call(fop, flags, path) : 0;
	if (fop == (uint8_t)CCU_FETCH)
		/*
		 * A FETCH IS ALSO THE INVALIDATION, and it is the only one the
		 * mutating ops need: every op that can change a file routes with
		 * FETCH — including `setxattr` and `removexattr`, which look like
		 * metadata reads and are not — and `cache_invalidate` clears the
		 * path AND its parent across every tgid.
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
	/* Three distinct reasons, because the event log is what the pin list is
	 * DERIVED from and "the remote does not have it" is a different finding
	 * from "cc would not carry it" and from "cc could not be reached". */
	if (rc == -EIO)         policy_event(EV_DENY, op, path, "control-unavailable", tid);
	else if (rc == -ENOENT) policy_event(EV_DENY, op, path, "remote-absent", tid);
	else if (rc)            policy_event(EV_DENY, op, path, "control-refused", tid);
	return rc;
}

#endif /* CC_UNION_POLICY_H */

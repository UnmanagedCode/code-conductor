/*
 * union-policy-driver.c — the unit fixture for src/systems/fuse/policy.h.
 *
 * policy.h includes no libfuse header and calls no FUSE function, so every rule
 * in it can be driven from here with a fake /proc, a fake clock and a fake
 * control transport. That is the whole point of the split: the tier
 * resolution, the marking policy and the frame codec are proven before anything
 * is mounted.
 *
 * ONE CASE PER PROCESS. `argv[1]` names the case and the process exits; the
 * tier table, the mark table and the resolution cache are file-scope state, so
 * a fresh process is the isolation rather than a reset function that would
 * exist only for tests.
 *
 * Prints `ok <case>/<n> <what>` per assertion and `FAIL …` on the first
 * failure; exit 0 = every assertion in the case held.
 */
#define _GNU_SOURCE
#include "../../src/systems/fuse/policy.h"

static int failures = 0, checks = 0;
static const char *case_name = "?";

#define CHECK(cond, ...) do {                                              \
	checks++;                                                          \
	if (cond) { printf("ok %s/%d ", case_name, checks); }              \
	else      { printf("FAIL %s/%d ", case_name, checks); failures++; }\
	printf(__VA_ARGS__);                                               \
	printf("\n");                                                      \
} while (0)

/* ── the three injected seams ───────────────────────────────────────────── */

static struct { pid_t pid; pid_t tgid; unsigned long long start; } ptab[32];
static size_t nptab = 0;

static void proc_set(pid_t pid, pid_t tgid, unsigned long long start)
{
	size_t i;
	for (i = 0; i < nptab; i++)
		if (ptab[i].pid == pid) { ptab[i].tgid = tgid; ptab[i].start = start; return; }
	ptab[nptab].pid = pid; ptab[nptab].tgid = tgid; ptab[nptab].start = start; nptab++;
}
static pid_t fake_tgid(pid_t pid)
{
	size_t i;
	for (i = 0; i < nptab; i++) if (ptab[i].pid == pid) return ptab[i].tgid;
	return -1;
}
static unsigned long long fake_start(pid_t pid)
{
	size_t i;
	for (i = 0; i < nptab; i++) if (ptab[i].pid == pid) return ptab[i].start;
	return 0;
}

static long long fake_now = 100000;
static long long fake_clock(void) { return fake_now; }

/* The canned control channel. `xport_fail` makes the transport itself fail,
 * which is the dead-cc case. */
static unsigned char canned[CCU_REPLY_LEN];
static int  xport_fail = 0;
static int  xport_short = 0;
static unsigned char last_req[CCU_REQ_HDR + CCU_MAX_PATH];
static size_t last_req_len = 0;
static int  xport_calls = 0;

static void canned_reply(uint8_t status, int32_t err)
{
	ccu_put32(canned, CCU_MAGIC);
	canned[4] = status; canned[5] = 0;
	ccu_put32(canned + 6, (uint32_t)err);
	ccu_put32(canned + 10, 0);
}

static ssize_t fake_roundtrip(void *ctx, const unsigned char *req, size_t reqlen,
			      unsigned char *rep, size_t repcap)
{
	(void)ctx;
	xport_calls++;
	if (reqlen <= sizeof(last_req)) { memcpy(last_req, req, reqlen); last_req_len = reqlen; }
	if (xport_fail) return -1;
	if (repcap < CCU_REPLY_LEN) return -1;
	memcpy(rep, canned, CCU_REPLY_LEN);
	return xport_short ? (ssize_t)(CCU_REPLY_LEN - 1) : (ssize_t)CCU_REPLY_LEN;
}

/*
 * THE FAKE /proc IDENTITY READERS. `comm` and `cmdline` join `starttime` and
 * `tgid` on `struct proc_reader` for the same reason those two are injected: a
 * cmdline carrying a NUL, a newline and a high byte has to be drivable without
 * forking a process that happens to have one, and the three ABSENCE outcomes
 * (`gone`, `unreadable`, `empty`) have to be produced on demand rather than
 * raced for.
 *
 * A pid this table does not name reads as GONE, which is what an unset fixture
 * pid really is.
 */
static struct {
	pid_t  pid;
	char   comm[64];
	size_t commlen;
	char   cmd[POLICY_CMDLINE_MAX + 2048];
	size_t cmdlen;
	int    comm_rc;                 /* 0 = report the bytes; else the status */
	int    cmd_rc;
} itab[8];
static size_t nitab = 0;

static size_t itab_slot(pid_t pid)
{
	size_t i;
	for (i = 0; i < nitab; i++)
		if (itab[i].pid == pid) return i;
	itab[nitab].pid = pid;
	itab[nitab].comm_rc = 0;
	itab[nitab].cmd_rc = 0;
	return nitab++;
}

/* `cmd` is COUNTED, never NUL-terminated-and-measured: an argv separator is a
 * NUL, so strlen would truncate every fixture at its first argument. */
static void proc_set_identity(pid_t pid, const char *comm, const char *cmd, size_t cmdlen)
{
	size_t i = itab_slot(pid);
	size_t cl = strlen(comm);

	if (cl > sizeof(itab[0].comm)) cl = sizeof(itab[0].comm);
	memcpy(itab[i].comm, comm, cl);
	itab[i].commlen = cl;
	if (cmdlen > sizeof(itab[0].cmd)) cmdlen = sizeof(itab[0].cmd);
	memcpy(itab[i].cmd, cmd, cmdlen);
	itab[i].cmdlen = cmdlen;
	itab[i].comm_rc = 0;
	itab[i].cmd_rc = 0;
}

/* The absence half: a reader that fails rather than one that returns bytes. */
static void proc_set_identity_fail(pid_t pid, int comm_rc, int cmd_rc)
{
	size_t i = itab_slot(pid);
	itab[i].commlen = 0;
	itab[i].cmdlen = 0;
	itab[i].comm_rc = comm_rc;
	itab[i].cmd_rc = cmd_rc;
}

static int fake_comm(pid_t pid, char *out, size_t n)
{
	size_t i, len;

	for (i = 0; i < nitab; i++) {
		if (itab[i].pid != pid) continue;
		if (itab[i].comm_rc) return itab[i].comm_rc;
		len = itab[i].commlen;
		if (len > n - 1) len = n - 1;
		memcpy(out, itab[i].comm, len);
		out[len] = '\0';
		return (int)len;
	}
	return POLICY_PROC_GONE;
}

/* CAPS EXACTLY AS THE REAL READER DOES — at `n - 1` — so the `\!truncated`
 * suffix is driven by the same arithmetic in the fixture and in production. */
static int fake_cmdline(pid_t pid, char *out, size_t n)
{
	size_t i, len;

	for (i = 0; i < nitab; i++) {
		if (itab[i].pid != pid) continue;
		if (itab[i].cmd_rc) return itab[i].cmd_rc;
		len = itab[i].cmdlen;
		if (len > n - 1) len = n - 1;
		memcpy(out, itab[i].cmd, len);
		out[len] = '\0';
		return (int)len;
	}
	return POLICY_PROC_GONE;
}

/* ONE ROW, SPLIT INTO ITS EIGHT COLUMNS IN PLACE. The escaper guarantees no
 * field carries a raw tab or newline, which is exactly what makes this split
 * total. Returns the column count. */
static int split_row(char *line, char **col, int cap)
{
	int n = 0;
	char *p = line, *t;

	t = strchr(p, '\n');
	if (t) *t = '\0';
	for (;;) {
		if (n >= cap) return n;
		col[n++] = p;
		if (!(t = strchr(p, '\t'))) break;
		*t = '\0';
		p = t + 1;
	}
	return n;
}

static void seams(void)
{
	policy_proc.tgid = fake_tgid;
	policy_proc.starttime = fake_start;
	policy_proc.comm = fake_comm;
	policy_proc.cmdline = fake_cmdline;
	policy_clock = fake_clock;
	ccu_xport.roundtrip = fake_roundtrip;
	canned_reply(CCU_READY, 0);
}

static void pin(const char *line)
{
	char buf[PATH_MAX + 64];
	snprintf(buf, sizeof(buf), "%s", line);
	if (pins_parse_line(buf) != 0) {
		printf("FAIL %s: pins_parse_line('%s'): %s\n", case_name, line, policy_err);
		exit(1);
	}
}

/* ── the host-existence probe's fixture ─────────────────────────────────── */
/*
 * ONE mkdtemp'd TREE PER CASE, with `policy_host_fd` opened on the REAL ROOT
 * and every probe path spelled ABSOLUTELY from it. That is production's
 * arrangement exactly — `main()` opens the host root, every union path arrives
 * absolute — so `policy_rel` is exercised here the way production exercises it.
 *
 * DETERMINISTIC DESPITE NAMING THE REAL ROOT: every path asserted PRESENT is
 * created by the case itself, and every path asserted ABSENT is inside this
 * process's own mkdtemp, which no other process can name.
 */
static int host_root_fd(void)
{
	int fd = open("/", O_PATH | O_DIRECTORY);
	if (fd == -1) { printf("FAIL %s: open /\n", case_name); exit(1); }
	return fd;
}

static void host_box(char *box)
{
	if (!mkdtemp(box)) { printf("FAIL %s: mkdtemp\n", case_name); exit(1); }
}

static void hjoin(char *out, size_t n, const char *box, const char *suffix)
{
	snprintf(out, n, "%s%s", box, suffix);
}

static void hmkdir(const char *box, const char *suffix)
{
	char p[PATH_MAX];
	hjoin(p, sizeof(p), box, suffix);
	if (mkdir(p, 0755) != 0) { printf("FAIL %s: mkdir %s\n", case_name, p); exit(1); }
}

static void hfile(const char *box, const char *suffix)
{
	char p[PATH_MAX];
	int fd;
	hjoin(p, sizeof(p), box, suffix);
	if ((fd = open(p, O_CREAT | O_WRONLY | O_TRUNC, 0644)) < 0) {
		printf("FAIL %s: create %s\n", case_name, p); exit(1);
	}
	close(fd);
}

static void hsymlink(const char *box, const char *suffix, const char *target)
{
	char p[PATH_MAX];
	hjoin(p, sizeof(p), box, suffix);
	if (symlink(target, p) != 0) { printf("FAIL %s: symlink %s\n", case_name, p); exit(1); }
}

static void hrm(const char *box, const char *suffix)
{
	char p[PATH_MAX];
	hjoin(p, sizeof(p), box, suffix);
	if (unlink(p) != 0 && rmdir(p) != 0) { /* best effort teardown */ }
}

/* ── B1: longest prefix wins, at a component boundary ───────────────────── */
static void b1_prefix(void)
{
	pin("host\t/tmp/app");
	pin("project\t/tmp/app/inner");
	anc_build();
	CHECK(tier_of("/tmp/app", VIEW_CLI) == T_HOST, "the pin itself is host");
	CHECK(tier_of("/tmp/app/x", VIEW_CLI) == T_HOST, "a child at a boundary is host");
	CHECK(tier_of("/tmp/apple", VIEW_CLI) == T_FAIL, "/tmp/apple does NOT match the pin /tmp/app");
	CHECK(tier_of("/tmp/app-1/x", VIEW_CLI) == T_FAIL, "a sibling sharing the first bytes does not match");
	CHECK(tier_of("/tmp/app/inner/deep", VIEW_CLI) == T_PROJECT, "the LONGER pin wins over the shorter");
}

/* ── B2: an unpinned path is fail-closed, never remote-first ────────────── */
static void b2_failclosed(void)
{
	CHECK((int)T_FAIL == 0, "T_FAIL is enum index 0 (got %d)", (int)T_FAIL);
	pin("host\t/etc/passwd");
	anc_build();
	CHECK(tier_of("/nowhere/at/all", VIEW_CLI) == T_FAIL, "an unpinned path is T_FAIL");
	CHECK(tier_of("/nowhere/at/all", VIEW_CLI) == (enum tier)0, "and T_FAIL is what tier_of returns for no match");
	/* The mechanism, not just the value: an EMPTY table answers fail for
	 * everything, which is what "fail-closed by construction" means. */
	npins = 0;
	CHECK(tier_of("/", VIEW_CLI) == T_FAIL, "with no pins at all, even / is fail");
}

/* ── B3: the ancestor set is EXACT membership, not a prefix rule ────────── */
static void b3_ancestors(void)
{
	pin("host\t/usr/bin/sh");
	anc_build();
	CHECK(resolve_class("/usr", VIEW_CLI) == T_SYNTH, "a strict ancestor of a pin is synthetic");
	CHECK(resolve_class("/usr/bin", VIEW_CLI) == T_SYNTH, "and so is the next one down");
	CHECK(resolve_class("/", VIEW_CLI) == T_SYNTH, "/ is always in the set");
	CHECK(resolve_class("/usr/bin/sh", VIEW_CLI) == T_HOST, "the pin itself keeps its own tier");
	CHECK(resolve_class("/usrX", VIEW_CLI) == T_FAIL, "/usrX is NOT an ancestor — membership is exact");
	CHECK(resolve_class("/usr/bi", VIEW_CLI) == T_FAIL, "nor is a prefix of a component");
	CHECK(resolve_class("/usr/lib", VIEW_CLI) == T_FAIL, "nor an unrelated sibling");
}

/* An exactly-pinned path is that pin, never a synthetic node: the pin is the
 * more specific statement and anc_build drops it from the set. */
static void b3b_exact_pin_wins(void)
{
	pin("host\t/usr");
	pin("host\t/usr/bin/sh");
	anc_build();
	CHECK(anc_find("/usr") < 0, "an exactly-pinned ancestor is dropped from the set");
	CHECK(resolve_class("/usr", VIEW_CLI) == T_HOST, "and resolves to its pin");
	CHECK(resolve_class("/usr/bin", VIEW_CLI) == T_HOST, "its unpinned child follows the pin, not the set");
}

/* ── B4: a synthetic dir lists exactly its own children ─────────────────── */
static char listed[64][256];
static size_t nlisted;
static void collect(void *ctx, const char *name, const char *full, enum tier t)
{
	(void)ctx; (void)full; (void)t;
	if (nlisted < 64) snprintf(listed[nlisted++], 256, "%s", name);
}
static int listed_has(const char *n)
{
	size_t i;
	for (i = 0; i < nlisted; i++) if (strcmp(listed[i], n) == 0) return 1;
	return 0;
}
static void b4_children(void)
{
	pin("host\t/usr/bin/sh");
	pin("project\t/srv/app");
	pin("bind\t/proc");
	pin("hide\t/run/scaffold");
	pin("fail\t/var/secret");
	anc_build();

	nlisted = 0;
	policy_synth_children("/", VIEW_CLI, collect, NULL);
	CHECK(listed_has("usr"), "/ lists the synthetic ancestor usr");
	CHECK(listed_has("srv"), "/ lists the synthetic ancestor srv");
	CHECK(listed_has("proc"), "/ lists the bind node proc");
	CHECK(listed_has("run"), "/ lists run — an ancestor of a hide pin is still traversable");
	CHECK(listed_has("var"), "/ lists var — an ancestor of a fail pin is still traversable");
	CHECK(!listed_has("sh") && !listed_has("app"), "/ lists no GRANDchild");
	CHECK(nlisted == 5, "/ lists exactly its five children, got %zu", nlisted);

	nlisted = 0;
	policy_synth_children("/run", VIEW_CLI, collect, NULL);
	CHECK(nlisted == 0, "a hide child is suppressed from its parent's listing, got %zu", nlisted);

	nlisted = 0;
	policy_synth_children("/var", VIEW_CLI, collect, NULL);
	CHECK(nlisted == 0, "a fail child is suppressed too — every op on it answers -ENOENT");

	nlisted = 0;
	policy_synth_children("/usr", VIEW_CLI, collect, NULL);
	CHECK(nlisted == 1 && listed_has("bin"), "/usr lists exactly bin");

	nlisted = 0;
	policy_synth_children("/usr/bin", VIEW_CLI, collect, NULL);
	CHECK(nlisted == 1 && listed_has("sh"), "/usr/bin lists exactly the host pin sh");
}

/* ── B5: the synthetic node's attributes are fixed, and no filesystem is
 *        touched to produce them ─────────────────────────────────────────── */
static void b5_getattr(void)
{
	struct stat st, st2;
	/* A PIN UNDER A PATH THAT DOES NOT EXIST ON THIS HOST. If the fill ever
	 * consulted the host directory of the same name it would answer -ENOENT
	 * here, so this arm cannot pass through a host stat. */
	pin("host\t/zzz-no-such-root-on-this-host/deep/leaf");
	/* And a path that DOES exist on the host with different attributes. */
	pin("host\t/usr/bin/sh");
	anc_build();

	CHECK(policy_synth_getattr("/zzz-no-such-root-on-this-host", &st, VIEW_CLI) == 0,
	      "a synthetic node over a nonexistent host path still answers");
	CHECK((st.st_mode & 07777) == 0555 && S_ISDIR(st.st_mode), "mode is a 0555 directory (got %o)", st.st_mode);
	CHECK(st.st_uid == 0 && st.st_gid == 0, "uid and gid are 0");
	CHECK(st.st_nlink == 2, "nlink is 2");
	CHECK(st.st_size == 0, "size is 0");
	CHECK(st.st_atime == 0 && st.st_mtime == 0 && st.st_ctime == 0, "all three times are 0");
	CHECK(st.st_ino >= SYNTH_INO_BASE, "the inode comes from the ancestor table");

	CHECK(policy_synth_getattr("/usr", &st2, VIEW_CLI) == 0, "and over a host path that DOES exist");
	CHECK(st2.st_mtime == 0 && (st2.st_mode & 07777) == 0555,
	      "it answers the fixed node, not the host's /usr (mode %o mtime %lld)",
	      st2.st_mode, (long long)st2.st_mtime);
	CHECK(st2.st_ino != st.st_ino, "two synthetic nodes get distinct inodes");
	CHECK(policy_synth_getattr("/not/in/the/table", &st2, VIEW_CLI) == -ENOENT,
	      "a path outside the table is not synthetic");

	/* Stable across calls, which is what makes the inode usable at all. */
	{
		struct stat a, b;
		policy_synth_getattr("/usr", &a, VIEW_CLI);
		policy_synth_getattr("/usr", &b, VIEW_CLI);
		CHECK(a.st_ino == b.st_ino, "a synthetic inode is stable for the life of the mount");
	}
}

/* ── B6: every mutating op owes a synthetic or bind node EROFS ───────────── */
static void b6_erofs(void)
{
	CHECK(policy_mutation_check(T_SYNTH) == -EROFS, "T_SYNTH mutation is EROFS");
	CHECK(policy_mutation_check(T_BIND)  == -EROFS, "T_BIND mutation is EROFS");
	CHECK(policy_mutation_check(T_SYNTH) != -EACCES, "and NOT EACCES — no permissions fix exists");
	CHECK(policy_mutation_check(T_HOST)    == 0, "a host path may be mutated");
	CHECK(policy_mutation_check(T_PROJECT) == 0, "so may a project path");
	CHECK(policy_mutation_check(T_HIDE)    == 0, "hide is answered -ENOENT before this, so it is not this check's job");
	CHECK(policy_mutation_check(T_FAIL)    == 0, "and neither is fail");
}

/* ── B7: unmarked at a project path is -ENOENT ──────────────────────────── */
/*
 * A LIVENESS GUARD, DRIVEN HERE. In production an unmarked caller cannot reach
 * `policy_project_route` at all: it resolves in `VIEW_HOST`, where `tier_of`
 * skips every `project` pin, so no unmarked resolution can produce T_PROJECT
 * and route() cannot dispatch one here. The live mechanism is the VIEW, where
 * the invariant is structural — `b41` pins it.
 *
 * THE MARK CHECK STAYS AS DEFENCE IN DEPTH on the only function that sends a
 * control frame, and -ENOENT is still the correct answer if a later edit ever
 * reopens the route. This case drives it directly, which is the only way it CAN
 * be driven.
 */
static void b7_unmarked(void)
{
	pin("project\t/srv/app");
	pin("host\t/usr/bin/sh");
	anc_build();
	proc_set(500, 500, 111);          /* an unmarked thread group */
	proc_set(600, 600, 222);          /* the one we will mark */

	CHECK(policy_project_route("getattr", "/srv/app/x", 500, CCU_STAT, 0) == -ENOENT,
	      "an unmarked caller at a project path gets -ENOENT");
	CHECK(xport_calls == 0, "and no control frame was sent on its behalf");

	policy_mark_tid(600);
	CHECK(policy_project_route("getattr", "/srv/app/x", 600, CCU_STAT, 0) == 0,
	      "a marked caller is served");
	CHECK(xport_calls == 1, "which took exactly one control call");

	/* THE OTHER HALF OF CRITERION 6: a host pin is served to marked and
	 * unmarked callers alike, and route() reaches it without consulting the
	 * mark at all — the classification alone decides. */
	CHECK(resolve_class("/usr/bin/sh", VIEW_CLI) == T_HOST,
	      "a host pin classifies as host with no caller in the question");
}

/* ── B8: a moved field-22 starttime drops the mark ──────────────────────── */
static void b8_reuse(void)
{
	pin("project\t/srv/app");
	anc_build();
	proc_set(700, 700, 4242);
	policy_mark_tid(700);
	CHECK(policy_is_marked_tid(700) == 1, "the thread group is marked");
	proc_set(700, 700, 9999);         /* the pid was recycled */
	CHECK(policy_is_marked_tid(700) == 0, "a moved starttime drops the mark");
	CHECK(policy_is_marked_tid(700) == 0, "and it stays dropped — the entry was evicted");
	policy_mark_tid(700);
	CHECK(policy_is_marked_tid(700) == 1, "the successor can be marked in its own right");
}

/* ── B9: the mark is keyed on the TGID, resolved through the reader ─────── */
static void b9_tgid_key(void)
{
	proc_set(800, 800, 55);           /* the leader */
	proc_set(837, 800, 55);           /* one of its threads: TID != TGID */
	proc_set(900, 900, 66);           /* an unrelated process */

	policy_mark_tid(800);
	CHECK(policy_is_marked_tid(800) == 1, "the leader is marked");
	CHECK(policy_is_marked_tid(837) == 1,
	      "a SIBLING THREAD of the marked group is marked — the key is the tgid, not the tid");
	CHECK(policy_is_marked_tid(900) == 0, "an unrelated thread group is not");
	CHECK(mark_of(837) == 0, "and 837 is not itself a marked tgid — the reader did the work");

	/* Marking through a non-leader TID marks the GROUP, not the thread. */
	proc_set(950, 940, 77);
	proc_set(940, 940, 77);
	policy_mark_tid(950);
	CHECK(policy_is_marked_tid(940) == 1, "marking via a thread marks its whole group");
}

/* ── B10: a resolution warmed by one tgid is never served to another ────── */
static void b10_cache_key(void)
{
	pin("project\t/srv/app");
	anc_build();
	proc_set(1000, 1000, 11);
	proc_set(2000, 2000, 22);
	policy_mark_tid(1000);            /* A is marked; B is NOT */

	CHECK(policy_project_route("getattr", "/srv/app/f", 1000, CCU_STAT, 0) == 0, "A is served");
	CHECK(xport_calls == 1, "A took one control call");
	CHECK(policy_project_route("getattr", "/srv/app/f", 1000, CCU_STAT, 0) == 0, "A again");
	CHECK(xport_calls == 1, "A's second op was a cache HIT — no second control call");

	/* THE CRITERION: B is unmarked and there is a warm entry for the very
	 * path it asks about. */
	CHECK(policy_project_route("getattr", "/srv/app/f", 2000, CCU_STAT, 0) == -ENOENT,
	      "B is denied despite A's warm entry for the same path");

	/* The raw key. It keeps an entry from outliving the thread group it was
	 * resolved for; it is NOT what stops an unmarked caller being served. */
	{
		int err = -1;
		CHECK(cache_get(1000, "/srv/app/f", &err) == 1, "A's entry is in the cache");
		CHECK(cache_get(2000, "/srv/app/f", &err) == 0, "B's is not");
	}

	/* The TTL, against the injected clock — no sleeping. */
	fake_now += CACHE_TTL_MS - 1;
	CHECK(policy_project_route("getattr", "/srv/app/f", 1000, CCU_STAT, 0) == 0, "still warm just before the TTL");
	CHECK(xport_calls == 1, "and still no new control call");
	fake_now += 2;
	CHECK(policy_project_route("getattr", "/srv/app/f", 1000, CCU_STAT, 0) == 0, "served again past the TTL");
	CHECK(xport_calls == 2, "which cost a fresh control call");

	/* FETCH never consults it, so freshness at open is exact. */
	CHECK(policy_project_route("open", "/srv/app/f", 1000, CCU_FETCH, 0) == 0, "an open is served");
	CHECK(xport_calls == 3, "and ALWAYS revalidates, warm entry or not");
	/* …and it invalidates, so a stat cannot answer from before the fetch. */
	CHECK(policy_project_route("getattr", "/srv/app/f", 1000, CCU_STAT, 0) == 0, "the next stat");
	CHECK(xport_calls == 4, "re-asks, because the FETCH invalidated the entry");

	/*
	 * AND THE CASE THE KEY CANNOT COVER, which is what puts the mark check in
	 * FRONT of the lookup: A's pid is RECYCLED while A's own entry is still
	 * warm. The successor has A's tgid, so it matches the key exactly; only
	 * `mark_of`'s field-22 re-read can tell it apart, and only if it runs
	 * first. Dies the moment the lookup is moved ahead of the mark check.
	 */
	{
		int e = -1;
		CHECK(cache_get(1000, "/srv/app/f", &e) == 1, "A's entry is still warm");
		proc_set(1000, 1000, 999);        /* pid 1000 is now a different process */
		CHECK(policy_project_route("getattr", "/srv/app/f", 1000, CCU_STAT, 0) == -ENOENT,
		      "a RECYCLED tgid was served the mark's warm entry");
		CHECK(cache_get(1000, "/srv/app/f", &e) == 1,
		      "and the entry is untouched — the mark check, not eviction, is what refused it");
		/* The eviction is permanent for this tgid, which is why this arm
		 * is last: a re-mark would be a different measurement. */
		CHECK(policy_is_marked_tid(1000) == 0, "and the mark itself is gone, once");
	}

}

/* ── B11: the frame codec ───────────────────────────────────────────────── */
static void b11_codec(void)
{
	unsigned char buf[64];
	unsigned char big[CCU_REQ_HDR + CCU_MAX_PATH + 8];
	char longpath[CCU_MAX_PATH + 8];
	struct ccu_reply rep;
	size_t len = 0;

	CHECK(ccu_encode_request(buf, sizeof(buf), CCU_STAT, 0, "/ab", &len) == 0, "a request encodes");
	CHECK(len == CCU_REQ_HDR + 3, "its length is the header plus the path (got %zu)", len);
	CHECK(ccu_get32(buf) == CCU_MAGIC, "magic is CCU1, big-endian");
	CHECK(buf[0] == 'C' && buf[1] == 'C' && buf[2] == 'U' && buf[3] == '1', "and reads as the four literal bytes");
	CHECK(buf[4] == CCU_STAT && buf[5] == 0, "op and flags");
	CHECK(buf[6] == 0 && buf[7] == 3, "pathlen is big-endian u16");
	CHECK(memcmp(buf + CCU_REQ_HDR, "/ab", 3) == 0, "the path follows, with no NUL");

	CHECK(ccu_encode_request(buf, sizeof(buf), CCU_FETCH, CCU_FLAG_FOR_CREATE, "/ab", &len) == 0, "for_create encodes");
	CHECK(buf[5] == CCU_FLAG_FOR_CREATE, "as flags bit 0");

	memset(longpath, 'x', sizeof(longpath));
	longpath[CCU_MAX_PATH + 1] = '\0';
	longpath[0] = '/';
	CHECK(ccu_encode_request(big, sizeof(big), CCU_STAT, 0, longpath, &len) == -ENAMETOOLONG,
	      "an over-long path is refused, not truncated");
	CHECK(ccu_encode_request(buf, 4, CCU_STAT, 0, "/ab", &len) == -EMSGSIZE, "so is a buffer that cannot hold the frame");

	canned_reply(CCU_ABSENT, 2);
	CHECK(ccu_decode_reply(canned, CCU_REPLY_LEN, &rep) == 0, "a well-formed reply decodes");
	CHECK(rep.status == CCU_ABSENT && rep.err == 2, "with its status and cc's errno");
	CHECK(ccu_decode_reply(canned, CCU_REPLY_LEN - 1, &rep) == -EIO, "a SHORT frame is refused");
	CHECK(ccu_decode_reply(canned, CCU_REPLY_LEN + 1, &rep) == -EIO, "and so is an over-long one");
	{
		unsigned char bad[CCU_REPLY_LEN];
		memcpy(bad, canned, sizeof(bad));
		bad[0] ^= 0xff;
		CHECK(ccu_decode_reply(bad, CCU_REPLY_LEN, &rep) == -EIO, "a bad magic is refused");
		memcpy(bad, canned, sizeof(bad));
		bad[4] = 99;
		CHECK(ccu_decode_reply(bad, CCU_REPLY_LEN, &rep) == -EIO, "and a status outside the enum");
	}
}

/* Prints the canonical wire vectors as hex, so the TypeScript codec
 * (src/systems/fuse/control.ts) can be asserted against THIS side's bytes
 * rather than against a second transcription of the spec. */
static void frame_vectors(void)
{
	unsigned char buf[64];
	size_t len = 0, i;

	ccu_encode_request(buf, sizeof(buf), CCU_FETCH, CCU_FLAG_FOR_CREATE, "/srv/app/f.txt", &len);
	printf("REQ ");
	for (i = 0; i < len; i++) printf("%02x", buf[i]);
	printf("\n");

	/* THE TWO INTENT BITS GO THROUGH THE SAME CROSS-LANGUAGE CHECK. They are
	 * the only thing standing between cc's cache management and the worker's
	 * intent, so a silent drift in either direction — a bit cc never sets, a
	 * bit the daemon reads as another — is a data-loss bug. One vector each,
	 * plus the pair, because a codec that ORs them into one value passes a
	 * single-bit vector. */
	ccu_encode_request(buf, sizeof(buf), CCU_FETCH, CCU_FLAG_FOR_WRITE, "/srv/app/f.txt", &len);
	printf("REQ_WRITE ");
	for (i = 0; i < len; i++) printf("%02x", buf[i]);
	printf("\n");

	ccu_encode_request(buf, sizeof(buf), CCU_FETCH,
			   CCU_FLAG_FOR_CREATE | CCU_FLAG_FOR_WRITE, "/srv/app/f.txt", &len);
	printf("REQ_CREATE_WRITE ");
	for (i = 0; i < len; i++) printf("%02x", buf[i]);
	printf("\n");

	ccu_encode_request(buf, sizeof(buf), CCU_DIRTY, CCU_FLAG_REMOVED, "/srv/app/f.txt", &len);
	printf("REQ_REMOVED ");
	for (i = 0; i < len; i++) printf("%02x", buf[i]);
	printf("\n");

	/* THE FOURTH BIT, and it goes through the same cross-language check for
	 * the same reason: a bit cc never sets means every written file uploads
	 * twice, and a bit cc reads as another means a release that reconciles
	 * nothing when it owed a full copy. Both are data-path defects, not
	 * codec nits. */
	ccu_encode_request(buf, sizeof(buf), CCU_DIRTY, CCU_FLAG_RELEASE_ONLY, "/srv/app/f.txt", &len);
	printf("REQ_RELEASE_ONLY ");
	for (i = 0; i < len; i++) printf("%02x", buf[i]);
	printf("\n");

	canned_reply(CCU_REFUSED, 13);
	printf("REPLY ");
	for (i = 0; i < CCU_REPLY_LEN; i++) printf("%02x", canned[i]);
	printf("\n");
}

/* ── B12: reply → errno ─────────────────────────────────────────────────── */
static void b12_errno(void)
{
	pin("project\t/srv/app");
	anc_build();
	proc_set(1100, 1100, 33);
	policy_mark_tid(1100);

	canned_reply(CCU_READY, 0);
	CHECK(ccu_call(CCU_STAT, 0, "/srv/app/f") == 0, "READY is success");

	canned_reply(CCU_ABSENT, 0);
	CHECK(ccu_call(CCU_STAT, 0, "/srv/app/f") == -ENOENT, "ABSENT maps to ENOENT");
	canned_reply(CCU_REFUSED, 0);
	CHECK(ccu_call(CCU_STAT, 0, "/srv/app/f") == -EACCES, "REFUSED maps to EACCES");

	/* cc's own errno wins over the canonical default: cc decides, the daemon
	 * does not invent. */
	canned_reply(CCU_REFUSED, EIO);
	CHECK(ccu_call(CCU_STAT, 0, "/srv/app/f") == -EIO, "cc's errno wins when it sets one");
	canned_reply(CCU_ABSENT, EACCES);
	CHECK(ccu_call(CCU_STAT, 0, "/srv/app/f") == -EACCES, "in either direction");

	canned_reply(CCU_READY, 0);
	xport_fail = 1;
	CHECK(ccu_call(CCU_STAT, 0, "/srv/app/f") == -EIO, "a DEAD channel is EIO");
	CHECK(policy_project_route("getattr", "/srv/app/f", 1100, CCU_STAT, 0) == -EIO,
	      "and the project route surfaces it, never a host fallback");
	xport_fail = 0;
	xport_short = 1;
	CHECK(ccu_call(CCU_STAT, 0, "/srv/app/f") == -EIO, "a TRUNCATED reply is EIO too");
	xport_short = 0;

	ccu_xport.roundtrip = NULL;
	CHECK(ccu_call(CCU_STAT, 0, "/srv/app/f") == -EIO, "and so is no transport at all");
}

/*
 * ── B14: the control failures each name themselves in the event log ───────
 *
 * R4 asserts the ABSENCE of `control-unavailable` and `control-refused` after a
 * real turn, which is vacuously true if neither is ever written. These are the
 * matching presence assertions, and they also pin that the THREE cases are
 * distinguished: the pin list is derived from this log, and "the remote does
 * not have it" is a different finding from "cc would not carry it" and from
 * "cc could not be reached".
 */
static void b14_control_reasons(void)
{
	char tmpl[] = "/tmp/cc-policy-ctlreasonsXXXXXX";
	int fd = mkstemp(tmpl);
	char line[512];
	int n_absent = 0, n_refused = 0, n_unavail = 0, n_unmarked = 0;

	if (fd < 0) { printf("FAIL %s: mkstemp\n", case_name); exit(1); }
	event_fp = fdopen(fd, "w+");
	setvbuf(event_fp, NULL, _IOLBF, 0);

	pin("project\t/srv/app");
	anc_build();
	proc_set(4000, 4000, 77);
	policy_mark_tid(4000);

	canned_reply(CCU_ABSENT, 0);
	CHECK(policy_project_route("getattr", "/srv/app/a", 4000, CCU_STAT, 0) == -ENOENT, "ABSENT denies");
	canned_reply(CCU_REFUSED, 0);
	CHECK(policy_project_route("getattr", "/srv/app/b", 4000, CCU_STAT, 0) == -EACCES, "REFUSED denies");
	xport_fail = 1;
	CHECK(policy_project_route("getattr", "/srv/app/c", 4000, CCU_STAT, 0) == -EIO, "a dead channel denies");
	xport_fail = 0;
	/* And the unmarked denial, whose reason R2 reads at the real gate. */
	proc_set(5000, 5000, 88);
	CHECK(policy_project_route("getattr", "/srv/app/d", 5000, CCU_STAT, 0) == -ENOENT, "unmarked denies");

	rewind(event_fp);
	while (fgets(line, sizeof(line), event_fp)) {
		if (strstr(line, "\tremote-absent\t"))            n_absent++;
		if (strstr(line, "\tcontrol-refused\t"))          n_refused++;
		if (strstr(line, "\tcontrol-unavailable\t"))      n_unavail++;
		if (strstr(line, "\tunmarked-project-denied\t"))  n_unmarked++;
		/* EVERY ONE OF THESE IS A DENIAL, so every row here carries kind
		 * `deny`. Asserted per row rather than by counting, so a single
		 * mis-kinded reason cannot hide behind three correct ones. */
		CHECK(strncmp(line, "deny\t", 5) == 0,
		      "a control failure is kind `deny`: %s", line);
	}
	CHECK(n_absent == 1, "ABSENT is logged as remote-absent (%d)", n_absent);
	CHECK(n_refused == 1, "REFUSED is logged as control-refused (%d)", n_refused);
	CHECK(n_unavail == 1, "a dead channel is logged as control-unavailable (%d)", n_unavail);
	CHECK(n_unmarked == 1, "an unmarked caller is logged as unmarked-project-denied (%d)", n_unmarked);
	fclose(event_fp);
	event_fp = NULL;
	unlink(tmpl);
}

/* ── B13: one caller's (path, reason) is recorded exactly once ──────────── */
static void b13_refusals(void)
{
	char tmpl[] = "/tmp/cc-policy-refusalsXXXXXX";
	int fd = mkstemp(tmpl);
	char line[512];
	int n_ax = 0, n_ay = 0, n_bx = 0, n_cz = 0, total = 0;
	FILE *rd;

	if (fd < 0) { printf("FAIL %s: mkstemp\n", case_name); exit(1); }
	event_fp = fdopen(fd, "w+");
	setvbuf(event_fp, NULL, _IOLBF, 0);

	/* ONE CALLER THROUGHOUT, so this case is about the (path, reason) half of
	 * the key alone; `b31` drives the tgid half. */
	proc_set(3100, 3100, 7);
	proc_set_identity(3100, "sh", "/bin/sh", 7);
	policy_event(EV_DENY,   "getattr", "/a", "x", 3100);
	policy_event(EV_DENY,   "getattr", "/a", "x", 3100);   /* same op, same pair */
	policy_event(EV_DENY,   "open",    "/a", "x", 3100);   /* DIFFERENT op, same pair */
	policy_event(EV_DENY,   "getattr", "/a", "y", 3100);   /* same path, different reason */
	policy_event(EV_DENY,   "getattr", "/b", "x", 3100);   /* different path, same reason */
	policy_event(EV_SERVED, "getattr", "/c", "z", 3100);   /* the other kind */

	rewind(event_fp);
	rd = event_fp;
	while (fgets(line, sizeof(line), rd)) {
		total++;
		if (strstr(line, "deny\tgetattr\t/a\tx\t"))   n_ax++;
		if (strstr(line, "deny\tgetattr\t/a\ty\t"))   n_ay++;
		if (strstr(line, "deny\tgetattr\t/b\tx\t"))   n_bx++;
		if (strstr(line, "served\tgetattr\t/c\tz\t")) n_cz++;
	}
	CHECK(n_ax == 1, "(/a, x) is recorded exactly once across THREE calls, got %d", n_ax);
	CHECK(n_ay == 1, "(/a, y) — a different reason for the same path is its own entry");
	CHECK(n_bx == 1, "(/b, x) — a different path is its own entry");
	CHECK(n_cz == 1, "an EV_SERVED row is written with kind `served` (%d)", n_cz);
	CHECK(total == 4, "four distinct pairs, four lines, got %d", total);
	/* THE KIND IS THE FIRST COLUMN AND THE ROW IS EIGHT COLUMNS. Asserted on the
	 * shape rather than only through the strstr needles above, which a row that
	 * appended the kind LAST would also satisfy. */
	rewind(event_fp);
	while (fgets(line, sizeof(line), rd)) {
		int tabs = 0;
		char *t;
		for (t = line; *t; t++) if (*t == '\t') tabs++;
		CHECK(tabs == 7, "the row has exactly seven tabs — kind, op, path, reason, pid, "
		      "tgid, comm, cmdline (%d): %s", tabs, line);
		CHECK(strncmp(line, "deny\t", 5) == 0 || strncmp(line, "served\t", 7) == 0,
		      "the FIRST column is the kind: %s", line);
	}
	/* WHAT THIS CASE DELIBERATELY DOES NOT PIN, so nobody credits it with the
	 * kind's place in the dedupe key. The key is (path, reason, tgid) and NOT
	 * (kind, path, reason, tgid), and THAT choice is UNOBSERVABLE: every reason
	 * maps to exactly one kind — derived from both C sources and set-compared
	 * in both directions by tests/fuse-union-policy.test.mjs — so the two keys
	 * partition every emission this daemon can produce identically, and no
	 * mutant can distinguish them. An assertion here would either duplicate
	 * the (/a, x) count above or manufacture a cross-kind emission the daemon
	 * cannot make. See policy_event's own comment for what that costs.
	 *
	 * THE TGID'S PLACE IN THE KEY IS `b31`'s, and it is the opposite kind of
	 * claim: dropping it silently discards every caller after the first. */
	fclose(event_fp);
	event_fp = NULL;
	unlink(tmpl);
}

/* ── the pins parser's own refusals ─────────────────────────────────────── */
static void b0_parse(void)
{
	char l1[] = "# a comment";
	char l2[] = "";
	char l3[] = "host\t/etc";
	char l4[] = "synth\t/derived";
	char l5[] = "host\trelative/path";
	char l6[] = "host";

	CHECK(pins_parse_line(l1) == 0 && npins == 0, "a comment adds no pin");
	CHECK(pins_parse_line(l2) == 0 && npins == 0, "nor does a blank line");
	CHECK(pins_parse_line(l3) == 0 && npins == 1, "a host rule adds one");
	CHECK(pins_parse_line(l4) == -1, "`synth` is REJECTED — it is derived, never parsed");
	CHECK(strstr(policy_err, "unknown kind") != NULL, "and says so: %s", policy_err);
	{
		/* AND `cwd` IS REJECTED THE SAME WAY — as is any derived
		 * class. This is the standing guard that no derived class can
		 * be smuggled into the artifact the hook's tier table shares:
		 * `renderPinsFile`'s consumers can only ever see the five kinds
		 * `pins_parse_line` accepts. */
		char lc[] = "cwd\t/srv/app";
		CHECK(pins_parse_line(lc) == -1, "`cwd` is REJECTED — it is derived, never parsed");
		CHECK(strstr(policy_err, "unknown kind") != NULL, "and says so: %s", policy_err);
	}
	CHECK(pins_parse_line(l5) == -1, "a relative path is rejected");
	CHECK(strstr(policy_err, "not absolute") != NULL, "and says so: %s", policy_err);
	CHECK(pins_parse_line(l6) == -1, "a kind with no path is rejected");
	{
		char l7[] = "bind\t/proc";
		char l8[] = "fail\t/var/x";
		char l9[] = "hide\t/run/y";
		char l10[] = "project\t/srv";
		CHECK(pins_parse_line(l7) == 0 && pins[npins - 1].tier == T_BIND, "bind parses");
		CHECK(pins_parse_line(l8) == 0 && pins[npins - 1].tier == T_FAIL, "fail parses");
		CHECK(pins_parse_line(l9) == 0 && pins[npins - 1].tier == T_HIDE, "hide parses");
		CHECK(pins_parse_line(l10) == 0 && pins[npins - 1].tier == T_PROJECT, "project parses");
	}
}

/*
 * b15 — WHAT A PROJECT-TIER OP OWES WHEN THE RECONCILE CANNOT CARRY IT.
 *
 * `policy_unreconcilable` has exactly `policy_mutation_check`'s shape — pure,
 * tier in, errno out, no libfuse. Both of its directions are asserted here, so
 * `return -EOPNOTSUPP` -> `return 0` and a flipped tier test die in the
 * DETERMINISTIC suite rather than only under the real gate.
 */
/* ── B16: abandon_claim ─────────────────────────────────────────────────── */
/*
 * THE GUARD AGAINST THE WORST FAILURE MODE OF THE CLAIM MECHANISM, and its
 * only behavioural coverage — without this case both of `policy_abandon_claim`'s
 * mutants are killed ONLY by A16's sha256 latch, which fires for any C edit and
 * so says nothing about behaviour.
 *
 * What it owes: a project-tier abandon SENDS A FRAME — a DIRTY carrying
 * CCU_FLAG_RELEASE_ONLY, because the op failed before mutating and the mirror
 * still holds cc's own unmodified cache copy, so there is nothing to reconcile
 * — and invalidates the cached routing decision. At any other tier it sends
 * nothing, because no other tier ever took a claim.
 *
 * A BARE ZERO would be indistinguishable on the wire from `pt_release`'s
 * releasing frame for a handle that WROTE and never flushed. The reasoning is
 * at the assertion.
 */
static void b16_abandon(void)
{
	int cerr;

	pin("project\t/srv/app");
	pin("host\t/etc/hosts");
	anc_build();
	proc_set(1300, 1300, 44);
	policy_mark_tid(1300);
	canned_reply(CCU_READY, 0);

	/* A warm cache entry, so the invalidation has something to remove. */
	cache_put(1300, "/srv/app/f", 0);
	CHECK(cache_get(1300, "/srv/app/f", &cerr) == 1, "the entry is warm to begin with");

	last_req_len = 0;
	policy_abandon_claim("/srv/app/f", T_PROJECT);

	CHECK(last_req_len > 0, "a project-tier abandon sends no frame, so the claim is never released");
	CHECK(last_req[4] == CCU_DIRTY, "the abandon frame is not a DIRTY");
	/* RELEASE_ONLY, AND EXACTLY THAT BIT.
	 *
	 * A REMOVED bit would tell cc to delete the source entry for an op that
	 * merely failed. A FOR_WRITE bit would tell it to KEEP the claim, the
	 * opposite of the whole point. AND A BARE ZERO is indistinguishable on
	 * the wire from the releasing frame of a handle that WROTE and never
	 * flushed, so cc would read an abandon as a reconcile: it would push the
	 * mirror's unmodified cache copy and, if that push failed, record a
	 * `diverged` fault and freeze its cache for the session on a file the
	 * worker never wrote.
	 *
	 * RELEASE_ONLY says what an abandon means and nothing else — release the
	 * claim, carry nothing — so no push is attempted and no fault can arise.
	 * It also drops a whole-file upload from every error path, and with it
	 * the hazard of overwriting the box's newer bytes with cc's stale cache
	 * copy. */
	CHECK(last_req[5] == CCU_FLAG_RELEASE_ONLY,
	      "the abandon frame is not RELEASE_ONLY, so cc reads it as a reconcile of worker bytes");
	CHECK(cache_get(1300, "/srv/app/f", &cerr) == 0,
	      "the abandon left a stale routing decision cached");

	/* AND NOTHING AT ANY OTHER TIER — no claim was ever taken there, so a
	 * frame would be cc reconciling a path the worker never wrote. */
	last_req_len = 0;
	policy_abandon_claim("/etc/hosts", T_HOST);
	CHECK(last_req_len == 0, "a host-tier abandon sent a frame");
	policy_abandon_claim("/etc/hosts", T_BIND);
	CHECK(last_req_len == 0, "a bind-tier abandon sent a frame");
	policy_abandon_claim("/nowhere", T_FAIL);
	CHECK(last_req_len == 0, "a fail-tier abandon sent a frame");
	policy_abandon_claim("/usr", T_SYNTH);
	CHECK(last_req_len == 0, "a synthetic abandon sent a frame");
}

static void b15_unreconcilable(void)
{
	/* THE REFUSAL, and only at the tier whose mutations need reconciling. */
	CHECK(policy_unreconcilable(T_PROJECT) == -EOPNOTSUPP,
	      "a project-tier op outside the reconcile's domain refuses EOPNOTSUPP");

	/* AND THE OTHER DIRECTION, which is what makes it a rule rather than a
	 * constant: a host path IS the orchestrator's own file, so the op lands
	 * on it directly and there is nothing to reconcile. A mutant that
	 * refuses everywhere breaks every host-pinned chmod. */
	CHECK(policy_unreconcilable(T_HOST) == 0, "a host-tier op is not refused");
	CHECK(policy_unreconcilable(T_BIND) == 0, "a bind-tier op is not refused");
	CHECK(policy_unreconcilable(T_SYNTH) == 0,
	      "a synthetic node is policy_mutation_check's EROFS, not this");
	CHECK(policy_unreconcilable(T_HIDE) == 0, "a hidden path never reaches here");
	CHECK(policy_unreconcilable(T_FAIL) == 0, "an unpinned path never reaches here");

	/* THE TWO ERRNOS ARE DIFFERENT, and deliberately: EROFS says the node is
	 * read-only, EOPNOTSUPP says the filesystem cannot represent the
	 * operation. Collapsing them loses which one the caller is being told. */
	CHECK(policy_mutation_check(T_SYNTH) != policy_unreconcilable(T_PROJECT),
	      "the read-only and the unrepresentable answers are distinguishable");
}

/* ── B17: the cwd exemption at the project root ─────────────────────────── */
/* ── B18: the wide advertised mirror root IS repaired by the widening ────── */
/* ── B19: the caller-tier matrix, all six tiers × {marked, unmarked} ─────── */
/*
 * THE WHOLE MAP IN ONE TRUTH TABLE, RUN TWICE — ONCE PER HOST AXIS, so that a
 * single-pass matrix cannot pin half of it while the host filesystem quietly
 * decides the other half. Pass 1 leaves `policy_host_fd = -1` (the host has
 * nothing) and pass 2 opens the real root at a path this case created.
 *
 * THE LOOP BOUND CANNOT SILENTLY UNDER-COVER. `tier_name` (policy.h) switches
 * over `enum tier` with no `default:` arm, so an eighth member fails the
 * `-Wall -Werror` compile of this very fixture before any assertion runs. The
 * member NAMES are pinned in tests/fuse-union-policy.test.mjs against the enum
 * declaration itself.
 */
static void b19_caller_tier_matrix(void)
{
	char box[] = "/tmp/cc-policy-b19XXXXXX";
	char probe[PATH_MAX];
	int pass;

	host_box(box);
	hfile(box, "/p");
	hjoin(probe, sizeof(probe), box, "/p");
	/* THE CWD IS ELSEWHERE, deliberately: the probe path must not be a chain
	 * component, or the overlay would answer and this case would be about
	 * the chain instead of about the map. */
	cwd_path = "/srv/app";

	for (pass = 0; pass < 2; pass++) {
		int t;
		int seen_sub = 0, seen_identity = 0;

		/* PASS 0: no host fd at all. PASS 1: the real root, at a path
		 * this case created. THE TWO PASSES MUST AGREE — that is the
		 * assertion: the geometry AND the host axis are both out of the
		 * decision. */
		policy_host_fd = pass ? host_root_fd() : -1;
		CHECK(policy_host_absent(probe) == !pass,
		      "pass %d: the host axis is really %s", pass, pass ? "host-has" : "host-lacks");

		for (t = 0; t <= (int)T_SYNTH; t++) {
			enum tier ti = (enum tier)t;
			enum tier marked   = policy_caller_tier("getattr", probe, ti, 1, 500);
			enum tier unmarked = policy_caller_tier("getattr", probe, ti, 0, 500);

			/* THE MARKED SIDE IS IDENTITY AT EVERY TIER, ON BOTH
			 * AXES. A substitution that fired for the CLI too would
			 * serve it the host at `fail` — or, worse, at `project`,
			 * where the host copy is a DIFFERENT FILE. */
			CHECK(marked == ti, "pass %d marked: %s is unchanged (got %s)",
			      pass, tier_name(ti), tier_name(marked));
			if (ti == T_FAIL || ti == T_PROJECT || ti == T_SYNTH) {
				/* THE THREE CALLER-SENSITIVE TIERS, and they land
				 * on the SAME answer on BOTH passes: `project`
				 * and `synth` re-resolve in VIEW_HOST, where an
				 * unpinned non-chain path is `fail`, and `fail`
				 * is host unconditionally. */
				CHECK(unmarked == T_HOST,
				      "pass %d unmarked: %s → host (got %s)",
				      pass, tier_name(ti), tier_name(unmarked));
				seen_sub++;
			} else {
				/* hide, bind, host — every one unchanged, and
				 * each for its own reason: hide is what keeps
				 * the mirror and the control socket
				 * unreachable, bind is resolved by unmarked
				 * `mount` before the mark fires, host already
				 * IS the host. VIEW_HOST strikes only `project`
				 * pins, so none of the three can move. */
				CHECK(unmarked == ti, "pass %d unmarked: %s is unchanged (got %s)",
				      pass, tier_name(ti), tier_name(unmarked));
				seen_identity++;
			}
		}
		/* NON-VACUITY, PER PASS: the loop really drove six tiers and saw
		 * three substitutions and three identities, so an empty or short
		 * loop cannot read as a pass. */
		CHECK(seen_sub == 3, "pass %d: all three caller-sensitive tiers were driven (%d)",
		      pass, seen_sub);
		CHECK(seen_identity == 3, "pass %d: and the remaining three were identity (%d)",
		      pass, seen_identity);
		if (policy_host_fd >= 0) close(policy_host_fd);
		policy_host_fd = -1;
	}
	cwd_path = NULL;
	hrm(box, "/p");
	rmdir(box);
}

/* ── B20: the set is EXACTLY {T_FAIL, T_PROJECT, T_SYNTH} ───────────────── */
/*
 * SEPARATE FROM B19 BECAUSE THE PREDICATE IS SEPARATE, and route() consults it
 * BEFORE the map: a tier wrongly in this set pays two /proc reads per op and
 * hands `policy_caller_tier` a tier it was not asked about, while a tier
 * wrongly OUT of it can never be substituted no matter what the map says — and
 * that second direction is what T_SYNTH is doing here. Dropping it leaves every
 * ancestor-of-a-pin directory answering an unmarked caller with a 0555 scaffold
 * node over a directory the orchestrator HAS, which epic criterion 4 calls "a
 * violation, not a rounding" and which nothing else in this fixture can see.
 */
static void b20_caller_sensitive_set(void)
{
	int t;
	int n_sensitive = 0;

	for (t = 0; t <= (int)T_SYNTH; t++) {
		enum tier ti = (enum tier)t;
		int want = (ti == T_FAIL || ti == T_PROJECT || ti == T_SYNTH);
		CHECK(policy_tier_is_caller_sensitive(ti) == want,
		      "%s is %scaller-sensitive", tier_name(ti), want ? "" : "NOT ");
		if (policy_tier_is_caller_sensitive(ti))
			n_sensitive++;
	}
	CHECK(n_sensitive == 3, "exactly three tiers are caller-sensitive (%d)", n_sensitive);
}

/* ── B21: the substitution denies nowhere; only policy_project_route does ── */
/*
 * THE OTHER HALF OF THE RULING, READ OFF THE LOG RATHER THAN OFF A RETURN
 * VALUE: driving every tier through the substitution — with the host holding an
 * entry at each probe path, which is the side where the T_PROJECT rule can
 * fire — writes NO `deny` row at all, and the only denial an unmarked caller
 * can take inside policy.h is `policy_project_route`'s mark check.
 */
static void b21_unmarked_refused_only_at_project(void)
{
	char box[] = "/tmp/cc-policy-b21hXXXXXX";
	char tmpl[] = "/tmp/cc-policy-b21XXXXXX";
	int fd = mkstemp(tmpl);
	char line[4096];
	int t, n_deny = 0, n_served = 0, n_project_deny = 0;

	if (fd < 0) { printf("FAIL %s: mkstemp\n", case_name); exit(1); }
	event_fp = fdopen(fd, "w+");
	setvbuf(event_fp, NULL, _IOLBF, 0);

	pin("project\t/srv/app");
	anc_build();
	cwd_path = "/srv/app";
	proc_set(500, 500, 111);               /* unmarked, and stays unmarked */

	/* THE HOST HAS AN ENTRY AT EVERY PROBE PATH — the side where a denial
	 * would write a `deny` row if the substitution ever denied one. */
	host_box(box);
	policy_host_fd = host_root_fd();

	/* EVERY TIER, one distinct path each so the dedupe cannot collapse rows
	 * and hide one. */
	for (t = 0; t <= (int)T_SYNTH; t++) {
		char suffix[32], path[PATH_MAX];
		snprintf(suffix, sizeof(suffix), "/probe-%d", t);
		hfile(box, suffix);
		hjoin(path, sizeof(path), box, suffix);
		CHECK(policy_host_absent(path) == 0, "the host has probe-%d", t);
		(void)policy_caller_tier("getattr", path, (enum tier)t, 0, 500);
	}
	rewind(event_fp);
	while (fgets(line, sizeof(line), event_fp)) {
		if (strncmp(line, "deny\t", 5) == 0)     n_deny++;
		if (strncmp(line, "served\t", 7) == 0)   n_served++;
	}
	CHECK(n_deny == 0, "the substitution denies at NO tier (%d deny rows)", n_deny);
	CHECK(n_served == 3,
	      "and it serves at exactly three — T_FAIL, T_PROJECT and T_SYNTH, all under the "
	      "one `fail -> host` rule they re-resolve into (%d served rows)", n_served);

	/* AND THE ONE DENIAL THERE IS. Non-vacuity for the zero above: an
	 * unmarked caller CAN be denied, at the project tier, and the sink this
	 * case reads really does record. */
	CHECK(policy_project_route("getattr", "/srv/app/f", 500, CCU_STAT, 0) == -ENOENT,
	      "an unmarked caller at a project path is still denied");
	rewind(event_fp);
	while (fgets(line, sizeof(line), event_fp))
		if (strstr(line, "deny\tgetattr\t/srv/app/f\tunmarked-project-denied\t"))
			n_project_deny++;
	CHECK(n_project_deny == 1, "and the denial is logged deny/unmarked-project-denied (%d)",
	      n_project_deny);
	fclose(event_fp);
	event_fp = NULL;
	unlink(tmpl);
	close(policy_host_fd);
	policy_host_fd = -1;
	for (t = 0; t <= (int)T_SYNTH; t++) {
		char suffix[32];
		snprintf(suffix, sizeof(suffix), "/probe-%d", t);
		hrm(box, suffix);
	}
	rmdir(box);
}

/* ── B22: the cwd chain's EXTENT, and both directions of the sibling trap ── */
/*
 * THE FIXTURE IS A PREFIX-SHARING SIBLING, IN BOTH DIRECTIONS, AND THAT IS THE
 * WHOLE POINT OF THE CASE. A case built from unrelated paths passes under the
 * naive `strncmp` this guard exists to reject and proves nothing.
 *
 * The two directions are rejected by DIFFERENT MECHANICS, so a case exercising
 * one proves half the guard:
 *   cwd /root/srv2, path /root/srv   → rejected by the BOUNDARY test
 *                                      (`cwd_path[9] == '2'`)
 *   cwd /root/srv,  path /root/srv2  → rejected by `strncmp` itself, which
 *                                      meets cwd's '\0' against '3'
 */
static void b22_cwd_chain_extent(void)
{
	/* NO HOST fd: this case drives the exemption, whose answer the
	 * host-existence substitution does not change — and stating the seam
	 * explicitly is what stops a future default silently substituting
	 * this chain out from under the case. */
	policy_host_fd = -1;
	pin("project\t/");
	pin("project\t/root/srv2");
	anc_build();
	proc_set(500, 500, 111);               /* unmarked */
	proc_set(600, 600, 222);
	policy_mark_tid(600);

	cwd_path = "/root/srv2";
	/* ── ON the chain ──────────────────────────────────────────────── */
	CHECK(policy_cwd_component("/") == 1, "/ is on the chain");
	CHECK(policy_cwd_component("/root") == 1, "and the intermediate component");
	CHECK(policy_cwd_component("/root/srv2") == 1, "and the cwd itself");
	/* ── OFF it — the sibling trap, direction one ───────────────────── */
	CHECK(policy_cwd_component("/root/srv") == 0,
	      "/root/srv is a SIBLING sharing a prefix — the boundary check is the "
	      "only thing rejecting it");
	CHECK(policy_cwd_component("/root/sr") == 0, "and so is /root/sr");
	CHECK(policy_cwd_component("/roo") == 0, "and /roo, a prefix of a component");
	CHECK(policy_cwd_component("/root/srv2x") == 0, "and /root/srv2x");
	CHECK(policy_cwd_component("/root/srv2/sub") == 0,
	      "a CHILD of the cwd is not a component — the chain is upward only");
	CHECK(policy_cwd_component("/root/other") == 0, "nor an unrelated sibling");
	CHECK(policy_cwd_component("relative/srv2") == 0, "nor a relative path");

	/* ── the sibling trap, DIRECTION TWO: the same pair reversed ────── */
	cwd_path = "/root/srv";
	CHECK(policy_cwd_component("/root/srv2") == 0,
	      "with cwd /root/srv the LONGER sibling /root/srv2 is off the chain — "
	      "rejected by strncmp, not by the boundary test");
	CHECK(policy_cwd_component("/root/srv") == 1, "while the cwd itself is on it");
	CHECK(policy_cwd_component("/root") == 1, "and its parent");

	/* ── WHAT THE PREDICATE NOW DECIDES: the OVERLAY's domain, reached
	 *    through resolve_class rather than through an exemption. The host
	 *    fd is unset, so `policy_host_absent` answers 1 everywhere and the
	 *    chain predicate is the only live conjunct — which is exactly the
	 *    isolation this case wants. ─────────────────────────────────── */
	cwd_path = "/root/srv2";
	pin("project\t/root/srv2");
	anc_build();
	CHECK(resolve_class("/root", VIEW_HOST) == T_SYNTH,
	      "an intermediate component the host lacks gets the overlay node");
	CHECK(resolve_class("/root/srv", VIEW_HOST) == T_FAIL,
	      "and its prefix-sharing sibling does NOT — it falls to fail, which is host");
	CHECK(resolve_class("/root/srv2/sub", VIEW_HOST) == T_FAIL,
	      "nor does a child of the cwd: the chain is upward only");
	CHECK(resolve_class("/root", VIEW_CLI) != T_SYNTH || anc_find("/root") >= 0,
	      "and VIEW_CLI reaches T_SYNTH only through the ancestor table, never the overlay");

	/* ── NO CWD AT ALL IS FAIL-CLOSED, and union.c refuses to mount on it
	 *    precisely because this is what it would mean: no floor, no overlay
	 *    node, and every unmarked chdir dead at its destination.
	 *    ───────────────────────────────────────────────────────────────── */
	cwd_path = NULL;
	CHECK(policy_cwd_component("/") == 0, "with no cwd injected, / is not a component");
	CHECK(policy_cwd_component("/root/srv2") == 0, "nor is the project root");
	CHECK(resolve_class("/root/srv2", VIEW_HOST) == T_FAIL,
	      "so no overlay node exists anywhere and the chdir dies");
}

/* ── B24: every reason maps to exactly ONE kind, at the policy.h sites ──── */
/*
 * THE KIND IS PINNED WHERE IT IS PRODUCED — read back out of the sink, never
 * asserted against a second transcription of the classification.
 *
 * THIS CASE COVERS EVERY REASON policy.h EMITS — the four control/mark ones and
 * the single substitution row.
 * The other reasons live in union.c op bodies no deterministic fixture can reach;
 * their kinds are pinned by a SOURCE-DERIVED two-directional set equality in
 * tests/fuse-union-policy.test.mjs, which reads every `policy_event(` call site
 * in both C sources. Split deliberately, and stated so neither half is credited
 * with the other's coverage.
 */
static void b24_event_kinds(void)
{
	char tmpl[] = "/tmp/cc-policy-b24XXXXXX";
	int fd = mkstemp(tmpl);
	char line[4096];
	int i, rows = 0;
	static const struct { const char *reason; const char *kind; } want[] = {
		{ "unmarked-project-denied",      "deny"   },
		{ "control-unavailable",          "deny"   },
		{ "remote-absent",                "deny"   },
		{ "control-refused",              "deny"   },
		{ "unmarked-host-served",         "served" },
	};
	int found[5] = { 0, 0, 0, 0, 0 };

	if (fd < 0) { printf("FAIL %s: mkstemp\n", case_name); exit(1); }
	event_fp = fdopen(fd, "w+");
	setvbuf(event_fp, NULL, _IOLBF, 0);

	pin("project\t/srv/app");
	anc_build();
	cwd_path = "/srv/app";
	proc_set(4000, 4000, 77);
	policy_mark_tid(4000);
	proc_set(5000, 5000, 88);              /* unmarked */

	/* One emission per reason, each at its own path so nothing dedupes. */
	(void)policy_project_route("getattr", "/srv/app/unmarked", 5000, CCU_STAT, 0);
	xport_fail = 1;
	(void)policy_project_route("getattr", "/srv/app/dead", 4000, CCU_STAT, 0);
	xport_fail = 0;
	canned_reply(CCU_ABSENT, 0);
	(void)policy_project_route("getattr", "/srv/app/absent", 4000, CCU_STAT, 0);
	canned_reply(CCU_REFUSED, 0);
	(void)policy_project_route("getattr", "/srv/app/refused", 4000, CCU_STAT, 0);
	(void)policy_caller_tier("getattr", "/unpinned/thing", T_FAIL, 0, 5000);

	rewind(event_fp);
	while (fgets(line, sizeof(line), event_fp)) {
		rows++;
		for (i = 0; i < (int)(sizeof(want) / sizeof(want[0])); i++) {
			char needle[128];
			snprintf(needle, sizeof(needle), "\t%s\t", want[i].reason);
			if (!strstr(line, needle))
				continue;
			found[i]++;
			CHECK(strncmp(line, want[i].kind, strlen(want[i].kind)) == 0
			      && line[strlen(want[i].kind)] == '\t',
			      "`%s` is kind `%s`: %s", want[i].reason, want[i].kind, line);
		}
	}
	for (i = 0; i < (int)(sizeof(want) / sizeof(want[0])); i++)
		CHECK(found[i] == 1, "`%s` was emitted exactly once (%d)",
		      want[i].reason, found[i]);
	/* SET EQUALITY, THE OTHER DIRECTION: one emission per reason, one row
	 * each and no extra — so a reason this table does not name cannot slip
	 * through unclassified. */
	CHECK(rows == (int)(sizeof(want) / sizeof(want[0])),
	      "one row per reason, nothing unclassified (%d)", rows);
	fclose(event_fp);
	event_fp = NULL;
	unlink(tmpl);
}

/* ── B25: one served row per (path, thread group) ────────────────────────── */
/*
 * THE SUBSTITUTION'S COST, PAID. After a substitution an unmarked caller's
 * missing object writes no `deny` row at all — the host's ENOENT is not a
 * policy event, and route() could not know about it anyway. So the row fires on
 * the SUBSTITUTION itself, whatever the subsequent host read does, and it means
 * "an unmarked caller was routed to the host" — which is precisely the fact the
 * pin list is read from.
 *
 * AND IT IS `served`, NOT `deny`: the op was not refused. A `deny` here would
 * put an every-shell-startup path into R4's fatal filter.
 *
 * ONE REASON FOR BOTH SUBSTITUTIONS. A project-tier path re-resolves in
 * `VIEW_HOST` and lands on the SAME `fail -> host` rule as everything else, so
 * both carry the one `unmarked-host-served` reason. Both are driven here, at one
 * path each, to pin that they produce the same row rather than two.
 */
static void b25_substitution_logged_per_path_and_tgid(void)
{
	char box[] = "/tmp/cc-policy-b25hXXXXXX";
	char tmpl[] = "/tmp/cc-policy-b25XXXXXX";
	char have[PATH_MAX], n_have[PATH_MAX + 64];
	char line[4096];
	int fd = mkstemp(tmpl);
	int n_served_a = 0, n_served_b = 0, n_served_have = 0;
	int n_any_project = 0, n_deny_project = 0, rows = 0;

	if (fd < 0) { printf("FAIL %s: mkstemp\n", case_name); exit(1); }
	event_fp = fdopen(fd, "w+");
	setvbuf(event_fp, NULL, _IOLBF, 0);

	pin("project\t/srv/app");
	anc_build();
	cwd_path = "/srv/app";
	proc_set(500, 500, 111);               /* unmarked */

	host_box(box);
	hfile(box, "/have");
	hjoin(have, sizeof(have), box, "/have");
	policy_host_fd = host_root_fd();

	/* TWICE at one path, once at another, ONE CALLER THROUGHOUT: the row is
	 * per distinct (path, thread group), which is what bounds the volume to
	 * roughly twenty per shell startup rather than to the op count. The
	 * thread-group half of that key is `b31`'s. */
	(void)policy_caller_tier("getattr", "/lib/x86_64-linux-gnu/libtinfo.so.6", T_FAIL, 0, 500);
	(void)policy_caller_tier("open",    "/lib/x86_64-linux-gnu/libtinfo.so.6", T_FAIL, 0, 500);
	(void)policy_caller_tier("getattr", "/var/other", T_FAIL, 0, 500);
	/* AND THE SAME AGAIN AT T_PROJECT: two ops, one row, under the SAME
	 * reason — the re-resolution lands on `fail`, which is host. */
	CHECK(policy_caller_tier("getattr", have, T_PROJECT, 0, 500) == T_HOST,
	      "an unmarked caller at a project path re-resolves to host");
	(void)policy_caller_tier("open",    have, T_PROJECT, 0, 500);

	/* THE PROJECT TIER'S OWN DENIAL IS STILL THE ANSWER FOR ANYTHING THAT
	 * REACHES IT — defence in depth now, since no unmarked caller can. */
	CHECK(policy_project_route("getattr", "/srv/app/f", 500, CCU_STAT, 0) == -ENOENT,
	      "policy_project_route still denies an unmarked caller");

	snprintf(n_have, sizeof(n_have), "served\tgetattr\t%s\tunmarked-host-served\t", have);
	rewind(event_fp);
	while (fgets(line, sizeof(line), event_fp)) {
		rows++;
		if (strstr(line, "served\tgetattr\t/lib/x86_64-linux-gnu/libtinfo.so.6\tunmarked-host-served\t"))
			n_served_a++;
		if (strstr(line, "served\tgetattr\t/var/other\tunmarked-host-served\t"))
			n_served_b++;
		if (strstr(line, n_have)) n_served_have++;
		if (strstr(line, "\t/srv/app/f\t")) {
			n_any_project++;
			if (strncmp(line, "deny\t", 5) == 0) n_deny_project++;
		}
	}
	CHECK(n_served_a == 1, "one served row per distinct path for one caller, across two ops (%d)", n_served_a);
	CHECK(n_served_b == 1, "and the second distinct path has its own (%d)", n_served_b);
	CHECK(n_served_have == 1,
	      "the project path writes ONE unmarked-host-served row across two ops — the same "
	      "reason as `fail`, not a second one (%d)", n_served_have);
	CHECK(n_any_project == 1, "the denied project path produced exactly one row (%d)", n_any_project);
	CHECK(n_deny_project == 1, "and it is a DENY row, never a served one (%d)", n_deny_project);
	CHECK(rows == 4, "four rows in total, so nothing extra was emitted (%d)", rows);
	fclose(event_fp);
	event_fp = NULL;
	unlink(tmpl);
	close(policy_host_fd);
	policy_host_fd = -1;
	hrm(box, "/have");
	rmdir(box);
}

/* ── B27: every chain component gets a DISTINCT inode, in its own range ─── */
/*
 * WHY THIS MATTERS, and the justification is something that FIRES:
 *
 *   1. `use_ino = 1` is the daemon's own stated invariant (`pt_init`: "A union
 *      must not invent st_ino… synthetic nodes supply their own from the
 *      ancestor table, in a range no real filesystem here hands out"). Distinct
 *      nodes get distinct inodes is a contract this file already makes.
 *   2. `test -ef` compares (st_dev, st_ino) in two `stat` calls and no readdir,
 *      so it is REACHABLE at a chain component. Under a collision
 *      `[ /root -ef /root/srv2 ]` would answer TRUE, which is plainly false.
 *
 * `getcwd(2)` does NOT observe it — it answers from the dentry cache and emits
 * no getdents — and `chdir(2)` compares no inodes. Named
 * here so the property is defended by the mechanisms that actually exercise it.
 */
static void b27_cwd_ino_distinct(void)
{
	static const char *chain[] = { "/", "/root", "/root/srv2" };
	unsigned long long ino[3];
	size_t i, j;

	pin("project\t/");                     /* pins[0] */
	pin("project\t/root/srv2");            /* pins[1] */
	pin("bind\t/proc");                    /* pins[2] */
	anc_build();
	cwd_path = "/root/srv2";

	for (i = 0; i < 3; i++) {
		struct stat st;
		/* POISONED, NOT ZEROED. A mutant that returns 0 without writing the
		 * node would hand back 0xAAAA… here — outside every asserted range
		 * — where a zero-init would have looked like a plausible inode. */
		memset(&st, 0xAA, sizeof(st));
		/* THROUGH THE OVERLAY'S OWN NODE, in VIEW_HOST: `policy_cwd_ino`
		 * is reached from `policy_synth_getattr` now, not from a
		 * dedicated cwd getattr. No host fd is open, so
		 * `policy_host_absent` answers 1 and every chain component takes
		 * the overlay. */
		CHECK(policy_synth_getattr(chain[i], &st, VIEW_HOST) == 0, "%s answers", chain[i]);
		ino[i] = (unsigned long long)st.st_ino;
	}

	/* ── PAIRWISE DISTINCT. `/root` has no exact pin, which is exactly the
	 *    case `policy_bind_ino` would collapse onto its single fallback. ── */
	for (i = 0; i < 3; i++)
		for (j = i + 1; j < 3; j++)
			CHECK(ino[i] != ino[j], "%s and %s have distinct inodes (%llu vs %llu)",
			      chain[i], chain[j], ino[i], ino[j]);
	CHECK(pin_exact("/root") == NULL,
	      "/root carries NO exact pin — the case policy_bind_ino collapses");
	CHECK(ino[1] != policy_bind_ino("/root"),
	      "so the chain inode is NOT policy_bind_ino's shared fallback (%llu)", ino[1]);

	/* ── AND THE THREE SUB-RANGES ARE DISJOINT. Three ranges over one base
	 *    is the arithmetic that silently overlaps after an edit. ───────── */
	for (i = 0; i < 3; i++) {
		CHECK(ino[i] >= SYNTH_INO_BASE + MAX_ANC + npins,
		      "%s is past BOTH the ancestor range and the %zu-entry pin range (%llu)",
		      chain[i], npins, ino[i]);
		CHECK(ino[i] < SYNTH_INO_BASE + MAX_ANC + npins + PATH_MAX,
		      "and inside the chain sub-range, which PATH_MAX bounds (%llu)", ino[i]);
	}
	/* The ancestor range's own top and the pin range's own top, so the
	 * boundaries are asserted against the neighbours rather than only against
	 * a lower bound. */
	CHECK(nancs <= MAX_ANC, "the ancestor range holds %zu entries", nancs);
	for (i = 0; i < npins; i++)
		CHECK(policy_bind_ino(pins[i].prefix) < SYNTH_INO_BASE + MAX_ANC + npins,
		      "the exact-pin inode for %s is below the chain sub-range", pins[i].prefix);
}

/* ── B28: CC_UNION_CWD is REFUSED when it is not normalised ─────────────── */
/*
 * SPLIT BY LAYER, DELIBERATELY. The predicate lives in policy.h and is driven
 * here; the MOUNT REFUSAL is in `union.c`'s `main()`, unreachable from this
 * fixture, and is pinned by a source-text assertion beside A16; and
 * `buildFusePlan`'s configuration-time assertion is a unit test in
 * tests/fuse-lifecycle.test.mjs. Three layers, three pins, each at the layer
 * that enforces it.
 *
 * A DOUBLED SLASH — OR A `.`/`..` COMPONENT — IS THE CASE THAT BITES, and it
 * bites at the LAST component: with `cwd = /root//srv2`, `policy_cwd_component`
 * matches `/` and `/root` and then fails on the cwd ITSELF, because the
 * comparison meets the spelling's second '/' against `a`. So the chdir walks
 * every intermediate component and dies at its destination, which is the
 * hardest shape to diagnose from the outside. Asserted below rather than
 * asserted ABOUT.
 *
 * A TRAILING SLASH IS DIFFERENT AND IS REFUSED ANYWAY. `cwd = /root/srv2/`
 * still matches every component, because the boundary test reads the trailing
 * '/' as the separator it is looking for — so this half of the predicate buys
 * no behavioural rescue and is here because CC OWNS THE INPUT: `plan.cwdInside`
 * is already absolute and normalised, so any other spelling is a cc defect and
 * the right response is a loud refusal rather than a silent repair. That is
 * also why the whole predicate refuses instead of normalising — resolving `..`
 * correctly needs the filesystem, because a component may be a symlink.
 */
static void b28_cwd_input_validated(void)
{
	CHECK(policy_cwd_normalised("/") == 1, "/ is normalised");
	CHECK(policy_cwd_normalised("/root/srv2") == 1, "and a plain absolute path");
	CHECK(policy_cwd_normalised("/a") == 1, "and a one-component one");

	/* REFUSED, BUT NOT BY THE CLAUSE THAT NAMES IT: deleting
	 * `policy_cwd_normalised`'s trailing-slash clause
	 * leaves this green, because a trailing slash leaves an EMPTY FINAL
	 * COMPONENT and the `end == c` clause refuses that. So this assertion pins
	 * the OUTCOME and no single clause; the C clause is redundant-by-
	 * construction and deliberately kept. The same conceptual check one layer
	 * up, in `buildFusePlan`, IS load-bearing — see policy_cwd_normalised's own
	 * comment for why the two differ. */
	CHECK(policy_cwd_normalised("/root/srv2/") == 0, "a TRAILING slash is refused");
	CHECK(policy_cwd_normalised("/root//srv2") == 0, "so is a doubled slash");
	CHECK(policy_cwd_normalised("//root") == 0, "including a leading doubled slash");
	CHECK(policy_cwd_normalised("/root/./srv2") == 0, "so is a `.` component");
	CHECK(policy_cwd_normalised("/root/../srv2") == 0, "and a `..` component");
	CHECK(policy_cwd_normalised("/root/..") == 0, "and a trailing `..`");
	CHECK(policy_cwd_normalised("/root/.") == 0, "and a trailing `.`");
	CHECK(policy_cwd_normalised("root/srv2") == 0, "a RELATIVE path is refused");
	CHECK(policy_cwd_normalised("") == 0, "and so is the empty string");
	CHECK(policy_cwd_normalised(NULL) == 0, "and NULL — the unset variable");

	/* NOT REJECTED, AND THAT IS DELIBERATE: a component that merely BEGINS
	 * with a dot is an ordinary directory name, and refusing `/root/.claude`
	 * would refuse a real cwd. */
	CHECK(policy_cwd_normalised("/root/.claude") == 1,
	      "a dotfile-named component is normal, not a `.` component");
	CHECK(policy_cwd_normalised("/root/..hidden") == 1, "and so is `..hidden`");

	/* AND THE CONSEQUENCE THE REFUSAL EXISTS FOR, asserted rather than
	 * asserted-about. A doubled slash matches every INTERMEDIATE component and
	 * then fails on the cwd itself, so the chdir dies at its destination —
	 * which is exactly the failure `union.c`'s mount refusal replaces with a
	 * named one. */
	cwd_path = "/root//srv2";
	CHECK(policy_cwd_component("/root") == 1,
	      "a doubled-slash cwd still matches the intermediate component");
	CHECK(policy_cwd_component("/root/srv2") == 0,
	      "and then fails on the CWD ITSELF, so the chdir dies at its destination");
	/* THE OTHER HALF, AND IT IS THE HONEST ONE: a trailing slash matches
	 * everything, so refusing it buys no behavioural rescue. It is refused
	 * because a non-normalised input is a cc defect, not because the
	 * comparison breaks on it. */
	cwd_path = "/root/srv2/";
	CHECK(policy_cwd_component("/root/srv2") == 1,
	      "a TRAILING-slash cwd still matches the cwd — the boundary test reads "
	      "the trailing '/' as the separator, so this spelling is refused on "
	      "ownership of the input rather than on a broken comparison");
	CHECK(policy_cwd_component("/root") == 1, "and its intermediate components too");

	/* THE THIRD MECHANISM, AND THERE ARE EXACTLY THREE IN THE REFUSED CLASS.
	 * `buildFusePlan`'s 501 names a consequence PER SHAPE because no clause is
	 * true of all three, and this is the one the other two are not: a
	 * NON-ABSOLUTE cwd matches "/" — answered before any comparison — and
	 * nothing else at all, so the chdir dies at the FIRST real component
	 * rather than at its destination. Driven here because the message claims
	 * it and this is the layer that decides it. */
	cwd_path = "srv/app";
	CHECK(policy_cwd_component("/") == 1,
	      "a non-absolute cwd still matches / — the predicate answers it before "
	      "comparing anything");
	CHECK(policy_cwd_component("/srv") == 0, "but NOT the first real component");
	CHECK(policy_cwd_component("/srv/app") == 0, "and not the cwd's own spelling");
}

/* ── B29: the escaper round-trips every byte class, losing no line ──────── */
/*
 * THE ROW IS TAB-SEPARATED AND NEWLINE-TERMINATED, so any field that can carry
 * an arbitrary byte can DESTROY it. `/proc/<pid>/cmdline` is NUL-separated and
 * a `bash -c` argv holds the whole script, newlines included: ONE unescaped
 * field splits one row into many and a consumer cannot recover the rest.
 *
 * `\\` IS FIRST, AND THAT ORDER IS THE ROUND TRIP. Escaping a tab to `\t`
 * before escaping the backslash would make a literal `\` followed by `t`
 * decode back as a tab.
 */
static void b29_escape(void)
{
	/* Every class in the table, in one string: a plain run, the escape
	 * character itself, all three line/field breakers, a NUL (the argv
	 * separator), a low control byte, DEL, and a high-bit UTF-8 sequence. */
	static const char src[] = {
		'a', '\\', 'b', '\t', 'c', '\n', 'd', '\r', 'e', '\0', 'f',
		0x01, 'g', 0x7f, (char)0xc3, (char)0xa9, 'z'
	};
	static const char want[] = "a\\\\b\\tc\\nd\\re\\0f\\x01g\\x7f\xc3\xa9z";
	char enc[256], small[8], exact[6];

	CHECK(policy_escape(enc, sizeof(enc), src, sizeof(src)) == 1,
	      "the whole string fit");
	CHECK(strcmp(enc, want) == 0,
	      "every byte class maps to its own escape (got '%s', want '%s')", enc, want);
	/* THE PROPERTY THE ROW FORMAT DEPENDS ON, asserted directly rather than
	 * only through the literal above: nothing that can split a row survives. */
	CHECK(strchr(enc, '\t') == NULL, "no raw TAB survives the escaper");
	CHECK(strchr(enc, '\n') == NULL, "no raw NEWLINE survives it");
	CHECK(strchr(enc, '\r') == NULL, "nor a raw CR");
	CHECK(strlen(enc) == sizeof(want) - 1,
	      "and no raw NUL either — the encoded field is one C string (%zu)", strlen(enc));
	/* HIGH BYTES ARE VERBATIM, so a UTF-8 path stays readable and still
	 * cannot break the parse. */
	CHECK(strstr(enc, "\xc3\xa9") != NULL, "a high-bit UTF-8 sequence is passed through");

	/* `\\` FIRST. A literal backslash followed by 't' must NOT collide with a
	 * real tab — the two encode differently, which is the whole round trip. */
	{
		char a[16], b[16];
		CHECK(policy_escape(a, sizeof(a), "\\t", 2) == 1, "a literal \\ + t encodes");
		CHECK(policy_escape(b, sizeof(b), "\t", 1) == 1, "and so does a real tab");
		CHECK(strcmp(a, "\\\\t") == 0, "the literal pair is '\\\\t' (got '%s')", a);
		CHECK(strcmp(b, "\\t") == 0, "and the tab is '\\t' (got '%s')", b);
		CHECK(strcmp(a, b) != 0, "so the two are DISTINGUISHABLE on decode");
	}

	/*
	 * IT REPORTS A SHORT BUFFER RATHER THAN OVERRUNNING IT, AND TERMINATES
	 * INSIDE IT — and the second half is the one that needs a poisoned buffer
	 * to be visible at all.
	 *
	 * THE FIT CHECK IS `o + w >= cap` AND THE `=` IS LOAD-BEARING. Under `>` a
	 * token that lands EXACTLY at `cap` is copied in full and the terminator
	 * then goes ONE BYTE PAST the buffer, so the field comes back
	 * unterminated. That matters beyond the overrun: "policy_escape never
	 * writes a partial token, so its output is a complete token sequence" is
	 * the premise `session.ts`'s alignment-aware decoder is sound on, and a
	 * premise whose own unit check cannot see the difference is not pinned.
	 *
	 * POISONED, NOT ZEROED, AND NOT MEASURED WITH strlen. `strlen` reads
	 * happily past the end, so it cannot see a MISSING in-bounds terminator;
	 * a zero-initialised buffer would hand the mutant the NUL it failed to
	 * write. `memchr` over exactly `sizeof` is the only form that observes it.
	 */
	memset(small, 'Z', sizeof(small));
	CHECK(policy_escape(small, sizeof(small), "abcdefghijkl", 12) == 0,
	      "a field that does not fit reports so");
	CHECK(memchr(small, '\0', sizeof(small)) != NULL,
	      "and terminates INSIDE the buffer");
	CHECK(strncmp(small, "abcdefg", 7) == 0,
	      "keeping the bytes it did fit (%.8s)", small);

	/* THE EXACT-EQUALITY ARM, which is the only one `>` and `>=` disagree on:
	 * `ab\x01` escapes to `ab` + the four-character `\x01`, so the last token
	 * ends precisely at cap 6. `>=` stops before it and terminates at index 2;
	 * `>` copies it, fills the buffer, and puts the terminator at index 6. */
	memset(exact, 'Z', sizeof(exact));
	CHECK(policy_escape(exact, sizeof(exact), "ab\x01", 3) == 0,
	      "a token ending EXACTLY at cap does not fit");
	CHECK(memchr(exact, '\0', sizeof(exact)) != NULL,
	      "and the terminator is still inside the buffer");
	CHECK(strncmp(exact, "ab", 2) == 0 && exact[2] == '\0',
	      "with the whole four-character escape left off rather than half of it");
}

/* ── B30: an absent identity is RECORDED, and cannot be forged ──────────── */
/*
 * A MISSING FIELD MUST NOT READ AS A VALUE. `exec(2)` and process exit both
 * race the sample, so `open`/`fopen` of the /proc entry failing is ordinary and
 * has to be told apart from a process that really has no cmdline (a kernel
 * thread) and from one the daemon may not read. The escaper never emits `\`
 * followed by `!`, which is what makes the `\!` namespace unforgeable — driven
 * below with an argv whose first bytes ARE the sentinel's spelling.
 */
static void b30_absence(void)
{
	char tmpl[] = "/tmp/cc-policy-b30XXXXXX";
	int fd = mkstemp(tmpl);
	static char line[1 << 16];
	int n_gone = 0, n_unreadable = 0, n_empty = 0, n_literal = 0, n_trunc = 0;
	static char big[POLICY_CMDLINE_MAX + 1024];

	if (fd < 0) { printf("FAIL %s: mkstemp\n", case_name); exit(1); }
	event_fp = fdopen(fd, "w+");
	setvbuf(event_fp, NULL, _IOLBF, 0);

	proc_set(7001, 7001, 1); proc_set_identity_fail(7001, POLICY_PROC_GONE, POLICY_PROC_GONE);
	proc_set(7002, 7002, 2); proc_set_identity_fail(7002, POLICY_PROC_UNREADABLE, POLICY_PROC_UNREADABLE);
	proc_set(7003, 7003, 3); proc_set_identity(7003, "", "", 0);
	/* AN ARGV THAT SPELLS A SENTINEL. If the encoder let it through verbatim a
	 * reader could not tell this process from one that had exited. */
	proc_set(7004, 7004, 4); proc_set_identity(7004, "sh", "\\!gone", 6);
	/* AND ONE PAST THE CAP: the reader fills the buffer, so the field says so. */
	memset(big, 'a', sizeof(big));
	proc_set(7005, 7005, 5); proc_set_identity(7005, "big", big, sizeof(big));

	policy_event(EV_DENY, "getattr", "/p-gone",       "x", 7001);
	policy_event(EV_DENY, "getattr", "/p-unreadable", "x", 7002);
	policy_event(EV_DENY, "getattr", "/p-empty",      "x", 7003);
	policy_event(EV_DENY, "getattr", "/p-literal",    "x", 7004);
	policy_event(EV_DENY, "getattr", "/p-truncated",  "x", 7005);

	rewind(event_fp);
	while (fgets(line, sizeof(line), event_fp)) {
		char *col[8];
		int n = split_row(line, col, 8);

		CHECK(n == 8, "the row has eight columns (%d)", n);
		if (n != 8) continue;
		if (strcmp(col[2], "/p-gone") == 0) {
			n_gone++;
			CHECK(strcmp(col[6], "\\!gone") == 0 && strcmp(col[7], "\\!gone") == 0,
			      "an ENOENT /proc read is recorded \\!gone (comm='%s' cmdline='%s')",
			      col[6], col[7]);
		}
		if (strcmp(col[2], "/p-unreadable") == 0) {
			n_unreadable++;
			CHECK(strcmp(col[6], "\\!unreadable") == 0 && strcmp(col[7], "\\!unreadable") == 0,
			      "any other failure is recorded \\!unreadable (comm='%s' cmdline='%s')",
			      col[6], col[7]);
		}
		if (strcmp(col[2], "/p-empty") == 0) {
			n_empty++;
			CHECK(strcmp(col[6], "\\!empty") == 0 && strcmp(col[7], "\\!empty") == 0,
			      "a successful ZERO-BYTE read is recorded \\!empty, not gone "
			      "(comm='%s' cmdline='%s')", col[6], col[7]);
		}
		if (strcmp(col[2], "/p-literal") == 0) {
			n_literal++;
			/* THE UNFORGEABILITY. Six raw bytes `\!gone` encode to seven,
			 * because the leading backslash doubles. */
			CHECK(strcmp(col[7], "\\\\!gone") == 0,
			      "an argv that SPELLS a sentinel is escaped, not passed through "
			      "(got '%s')", col[7]);
			CHECK(strcmp(col[7], "\\!gone") != 0,
			      "so it cannot be mistaken for the recorded absence");
			CHECK(strcmp(col[6], "sh") == 0, "and its comm is the plain value (%s)", col[6]);
		}
		if (strcmp(col[2], "/p-truncated") == 0) {
			size_t l = strlen(col[7]);
			size_t sl = strlen("\\!truncated");
			n_trunc++;
			CHECK(l > sl && strcmp(col[7] + l - sl, "\\!truncated") == 0,
			      "a cmdline past the cap carries the \\!truncated SUFFIX (%zu bytes)", l);
			CHECK(col[7][0] == 'a',
			      "and keeps the bytes it did read rather than collapsing to a sentinel");
			CHECK(l - sl == POLICY_CMDLINE_MAX - 1,
			      "exactly the cap's worth, one byte short of the buffer (%zu)", l - sl);
		}
	}
	CHECK(n_gone == 1 && n_unreadable == 1 && n_empty == 1,
	      "the three absences are DISTINCT values (%d/%d/%d)", n_gone, n_unreadable, n_empty);
	CHECK(n_literal == 1, "the literal-sentinel row was written (%d)", n_literal);
	CHECK(n_trunc == 1, "and the over-cap row (%d)", n_trunc);
	fclose(event_fp);
	event_fp = NULL;
	unlink(tmpl);
}

/* ── B31: the dedupe key carries the TGID, and pid/tgid are two columns ──── */
/*
 * WITHOUT THE TGID IN THE KEY THE ENRICHMENT IS ACTIVELY MISLEADING: a
 * (path, reason) key lets the FIRST caller to reach a path win the row and
 * silently drops every later one — so the row answers "who asked?" with
 * "whoever happened to be first". Attribution is the point of the column, so it
 * is the point of the key.
 */
static void b31_dedupe_tgid(void)
{
	char tmpl[] = "/tmp/cc-policy-b31XXXXXX";
	int fd = mkstemp(tmpl);
	char line[4096];
	int rows = 0, n_8001 = 0, n_8002 = 0, n_order = 0;

	if (fd < 0) { printf("FAIL %s: mkstemp\n", case_name); exit(1); }
	event_fp = fdopen(fd, "w+");
	setvbuf(event_fp, NULL, _IOLBF, 0);

	proc_set(8001, 8001, 11); proc_set_identity(8001, "one", "one", 3);
	proc_set(8002, 8002, 22); proc_set_identity(8002, "two", "two", 3);
	/* A THREAD, NOT A LEADER: tid 8103 belongs to thread group 8100, which is
	 * what pins which id lands in which column. */
	proc_set(8103, 8100, 33); proc_set_identity(8100, "thr", "thr", 3);

	policy_event(EV_DENY, "getattr", "/same", "r", 8001);
	policy_event(EV_DENY, "getattr", "/same", "r", 8001);   /* same everything */
	policy_event(EV_DENY, "open",    "/same", "r", 8001);   /* different OP, same key */
	policy_event(EV_DENY, "getattr", "/same", "r", 8002);   /* DIFFERENT tgid */
	policy_event(EV_DENY, "getattr", "/thread", "r", 8103);

	rewind(event_fp);
	while (fgets(line, sizeof(line), event_fp)) {
		char *col[8];
		int n = split_row(line, col, 8);

		rows++;
		CHECK(n == 8, "the row has eight columns (%d)", n);
		if (n != 8) continue;
		if (strcmp(col[2], "/same") == 0 && strcmp(col[5], "8001") == 0) n_8001++;
		if (strcmp(col[2], "/same") == 0 && strcmp(col[5], "8002") == 0) n_8002++;
		if (strcmp(col[2], "/thread") == 0) {
			n_order++;
			/* THE COLUMN ORDER IS pid THEN tgid, and a swap is invisible
			 * to every fixture whose caller is its own thread group. */
			CHECK(strcmp(col[4], "8103") == 0,
			      "column 5 is the CALLING THREAD's id (got '%s')", col[4]);
			CHECK(strcmp(col[5], "8100") == 0,
			      "and column 6 is its THREAD GROUP — the id the mark and the "
			      "dedupe key are on (got '%s')", col[5]);
			CHECK(strcmp(col[6], "thr") == 0,
			      "and comm is read from the THREAD GROUP (got '%s')", col[6]);
		}
	}
	CHECK(n_8001 == 1, "one (path, reason, tgid) row across three calls (%d)", n_8001);
	CHECK(n_8002 == 1, "and a SECOND caller at the same (path, reason) gets its own (%d)", n_8002);
	CHECK(n_order == 1, "the thread row was written once (%d)", n_order);
	CHECK(rows == 3, "three rows in total, so the dedupe still dedupes (%d)", rows);
	fclose(event_fp);
	event_fp = NULL;
	unlink(tmpl);
}

/* ── field-vectors: the C encoder's output, for the .mjs decoder to read ──── */
/*
 * THE CROSS-LANGUAGE ROUND TRIP, in the idiom `frame-vectors` already uses: the
 * C side EMITS real rows and PRINTS the raw bytes it put in them, and
 * `session.ts`'s decoder is asserted against those rather than against a second
 * transcription of the format. A C-only or a JS-only test proves neither half.
 *
 * FIVE ROWS, ONE PER SHAPE THE DECODER HAS TO TELL APART: an ordinary argv, the
 * FORGERY (below), and the three /proc outcomes that are not a value.
 *
 * THE FORGERY IS THE POINT OF ROW 2. A field whose RAW bytes END with a literal
 * `\` followed by `!truncated` encodes to `…\\!truncated` — because `\\` is
 * escaped first — and a decoder that strips the marker with a right-to-left
 * `endsWith` reads those last eleven characters as the marker, drops ten
 * content bytes and reports a COMPLETE read as truncated. The escaper's
 * guarantee is narrower than "the bytes `\!` never appear": it is that `\` is
 * never followed by `!` AT AN ESCAPE-ALIGNED POSITION, because every
 * `\`-initial token it emits is `\\`, `\t`, `\n`, `\r`, `\0` or `\xHH` and it
 * never writes a partial one. Only an alignment-aware decode can use that.
 *
 * `argv[2]` is the log path, and it is NOT unlinked — the .mjs reads it.
 */
/* ── B37: an unmarked caller can never be routed to the remote ──────────── */
/*
 * PINS: over all six tiers × {host-has, host-lacks} × {marked, unmarked},
 * `policy_caller_tier` returns either its INPUT tier or T_HOST and nothing
 * else, and at (unmarked, T_PROJECT) it is T_HOST ON BOTH HOST AXES. That is
 * the mechanical statement of "an unmarked caller never receives remote file
 * content, at any mirrorRoot". THE VIEW DENIES THE REMOTE, not a host probe,
 * which is why the host axis drops out of the map entirely — `b43` and `b48`
 * carry what the earlier host-probe arms proved.
 */
static void b37_unmarked_never_gets_remote(void)
{
	char box[] = "/tmp/cc-policy-b37XXXXXX";
	char have[PATH_MAX], lack[PATH_MAX];
	int t, h, m;
	int n_fail_sub = 0, n_project_sub = 0, n_synth_sub = 0, n_identity = 0;

	/* NO CWD INJECTED, deliberately: with the chain empty the overlay cannot
	 * fire, so every re-resolution lands on `fail` and this case stays about
	 * the map's RANGE rather than about the chain. `b39` owns the chain. */
	cwd_path = NULL;
	host_box(box);
	hfile(box, "/have");
	hjoin(have, sizeof(have), box, "/have");
	hjoin(lack, sizeof(lack), box, "/lack");
	policy_host_fd = host_root_fd();
	proc_set(500, 500, 111);

	CHECK(policy_host_absent(have) == 0, "the host-has axis is real");
	CHECK(policy_host_absent(lack) == 1, "and so is the host-lacks axis");

	for (t = 0; t <= (int)T_SYNTH; t++) {
		for (h = 0; h < 2; h++) {
			const char *p = h ? have : lack;
			for (m = 0; m < 2; m++) {
				enum tier ti = (enum tier)t;
				enum tier got = policy_caller_tier("getattr", p, ti, m, 500);

				CHECK(got == ti || got == T_HOST,
				      "%s/%s/%s → %s: the map returns the input tier or host, nothing else",
				      tier_name(ti), h ? "host-has" : "host-lacks",
				      m ? "marked" : "unmarked", tier_name(got));
				if (got == ti) { n_identity++; continue; }
				if (ti == T_FAIL) n_fail_sub++;
				if (ti == T_PROJECT) n_project_sub++;
				if (ti == T_SYNTH) n_synth_sub++;
			}
		}
	}
	/* THE HEADLINE, ASSERTED ON ITS OWN so it cannot be lost inside the
	 * disjunction above. */
	CHECK(policy_caller_tier("getattr", have, T_PROJECT, 0, 500) == T_HOST,
	      "unmarked at a host-having project path is HOST, never project");
	/* AND THE HOST AXIS IS OUT OF THE DECISION: all three caller-sensitive
	 * tiers substitute on BOTH axes. THE VIEW, NOT A HOST PROBE, is what
	 * denies the remote. */
	CHECK(policy_caller_tier("getattr", lack, T_PROJECT, 0, 500) == T_HOST,
	      "and so is an unmarked caller at a project path the host does NOT have");
	/* NON-VACUITY: every substitution was driven, and so were the
	 * identities — a loop that ran zero times would satisfy the disjunction. */
	CHECK(n_fail_sub == 2, "the T_FAIL substitution fired on both host axes, unmarked (%d)", n_fail_sub);
	CHECK(n_project_sub == 2, "the T_PROJECT one on both axes too (%d)", n_project_sub);
	CHECK(n_synth_sub == 2, "and the T_SYNTH one on both axes (%d)", n_synth_sub);
	CHECK(n_identity == 18,
	      "18 identities: 12 marked (six tiers x two axes) and six unmarked at "
	      "host/hide/bind (%d)", n_identity);

	close(policy_host_fd);
	policy_host_fd = -1;
	hrm(box, "/have");
	rmdir(box);
}

/* ── the three geometries, built from one input ─────────────────────────── */
/*
 * N, M and W are the three `mirrorRoot` values the product's geometry takes:
 * equal to `systemPath`, a STRICT ANCESTOR of it, and `/`. `buildTierTable`
 * emits `project mirrorRoot` AND `project systemPath` (tierTable.ts), which is
 * what makes the space between them project-tier. Everything else in the table
 * is identical at all three, so these three builds differ in exactly the one
 * way the product's geometry does.
 *
 * FIRST OCCURRENCE OF A PREFIX WINS, mirroring `buildTierTable`'s own dedupe: at
 * N the two project entries are the same string and the table carries one.
 */
static const char *GEOM_NAME[3] = {
	"N (mirrorRoot == systemPath)",
	"M (mirrorRoot a strict ancestor)",
	"W (mirrorRoot == /)",
};

static void geometry_ex(int g, const char *box, const char *systempath,
			const char *const *extra)
{
	char line[PATH_MAX + 32];
	const char *root = g == 0 ? systempath : g == 1 ? box : "/";
	size_t i;

	npins = 0;
	pin("host\t/etc/hostname");
	pin("hide\t/run/cc-union-scaffold");
	pin("bind\t/proc");
	/* EXTRA PINS BEFORE THE PROJECT ENTRIES, because `pins_parse_line` appends
	 * and `tier_of` takes the LONGEST prefix — order does not decide the
	 * answer, but building them here keeps a case's own shape adjacent to the
	 * table it is varying. */
	for (i = 0; extra && extra[i]; i++)
		pin(extra[i]);
	snprintf(line, sizeof(line), "project\t%s", root);
	pin(line);
	if (strcmp(root, systempath) != 0) {
		snprintf(line, sizeof(line), "project\t%s", systempath);
		pin(line);
	}
	anc_build();
}

static void geometry(int g, const char *box, const char *systempath)
{
	geometry_ex(g, box, systempath, NULL);
}

/* ── B38: the unmarked view does not vary with the geometry ─────────────── */
/*
 * PINS THE RULE'S WHOLE CLAIM. Build the pin set for N, M and W and assert the
 * `VIEW_HOST` resolution of one fixed path set is IDENTICAL across all three.
 * The moment a geometry re-enters the unmarked answer — a `mirrorRoot` test, an
 * ancestor-table consultation that a `project` pin's presence changes, a rule
 * keyed on how deep the project sits — this case dies.
 *
 * NON-VACUITY IS ASSERTED, NOT ASSUMED: `VIEW_CLI` is checked to DIFFER across
 * the same three builds at the same path, so the three geometries really are
 * three and the invariance above is a property of the view rather than of a
 * table that never changed.
 */
static void b38_view_is_geometry_invariant(void)
{
	char box[] = "/tmp/cc-policy-b38XXXXXX";
	char sys[PATH_MAX], leaf[PATH_MAX];
	enum tier want[8];
	const char *paths[8];
	int g, i;

	host_box(box);
	hjoin(sys, sizeof(sys), box, "/srv2");          /* NEVER created: the remote's */
	hjoin(leaf, sizeof(leaf), box, "/srv2/src/x.ts");
	policy_host_fd = host_root_fd();
	cwd_path = sys;

	paths[0] = "/";
	paths[1] = box;
	paths[2] = sys;
	paths[3] = leaf;
	paths[4] = "/etc/hostname";
	paths[5] = "/tmp";
	paths[6] = "/run/cc-union-scaffold";
	paths[7] = "/proc";

	for (g = 0; g < 3; g++) {
		geometry(g, box, sys);
		for (i = 0; i < 8; i++) {
			enum tier got = resolve_class(paths[i], VIEW_HOST);
			if (g == 0) { want[i] = got; continue; }
			CHECK(got == want[i],
			      "%s: %s resolves %s, same as at N", GEOM_NAME[g], paths[i], tier_name(got));
		}
	}

	/* AND THE ANSWERS ARE THE RIGHT ONES, not merely equal — three builds
	 * that all answered T_FAIL everywhere would satisfy the loop above. */
	geometry(0, box, sys);
	CHECK(resolve_class("/", VIEW_HOST) == T_FAIL,
	      "/ is the orchestrator's own, via fail -> host — never the scaffold node");
	CHECK(resolve_class(box, VIEW_HOST) == T_FAIL, "and so is the directory above the project");
	CHECK(resolve_class(sys, VIEW_HOST) == T_SYNTH,
	      "the cwd itself, which the orchestrator does not have, is the overlay node");
	CHECK(resolve_class(leaf, VIEW_HOST) == T_FAIL,
	      "a file UNDER the cwd is not a chain component: fail, and the host answers -ENOENT");
	CHECK(resolve_class("/etc/hostname", VIEW_HOST) == T_HOST, "a host pin is untouched");
	CHECK(resolve_class("/run/cc-union-scaffold", VIEW_HOST) == T_HIDE,
	      "and so is `hide` — VIEW_HOST strikes `project` alone");
	CHECK(resolve_class("/proc", VIEW_HOST) == T_BIND, "and `bind`");

	/* NON-VACUITY: the three builds really differ, in VIEW_CLI, at the path
	 * the geometry is about. */
	{
		enum tier cli[3];
		for (g = 0; g < 3; g++) {
			geometry(g, box, sys);
			cli[g] = resolve_class(box, VIEW_CLI);
		}
		CHECK(cli[0] == T_SYNTH,
		      "VIEW_CLI at N: the directory above the project is a synthetic ancestor (%s)",
		      tier_name(cli[0]));
		CHECK(cli[1] == T_PROJECT, "VIEW_CLI at M: it is the remote tier (%s)", tier_name(cli[1]));
		CHECK(cli[2] == T_PROJECT, "VIEW_CLI at W: the remote tier too (%s)", tier_name(cli[2]));
	}

	close(policy_host_fd);
	policy_host_fd = -1;
	cwd_path = NULL;
	rmdir(box);
}

/* ── B39: the chdir lives at every geometry ─────────────────────────────── */
/*
 * PINS: every component of the cwd chain is ENTERABLE in `VIEW_HOST` at N, M and
 * W — by the orchestrator's own directory with the floor's `--x` bits, or by the
 * overlay node where the orchestrator has none. At M the intervening component
 * carries an EXACT `project` pin and at W it is covered by prefix match, so all
 * three shapes of the chain are driven.
 *
 * THE 0700 LINK IS THE FIXTURE'S POINT, and it is asserted to be real rather
 * than assumed: the chain directory is created 0700, so its mode grants `x` to
 * the OWNER ALONE, and any other uid is refused search on it by the kernel under
 * `default_permissions` — exactly the orchestrator's `/root` shape. The case
 * asserts the un-floored mode really denies the other two classes before
 * asserting the floor grants them.
 */
static void b39_chdir_lives_at_every_geometry(void)
{
	char box[] = "/tmp/cc-policy-b39XXXXXX";
	char mid[PATH_MAX], sys[PATH_MAX];
	struct stat raw;
	int g;

	host_box(box);
	hmkdir(box, "/home");
	hjoin(mid, sizeof(mid), box, "/home");
	hjoin(sys, sizeof(sys), box, "/home/srv2");      /* NEVER created */
	if (chmod(mid, 0700) != 0) { printf("FAIL %s: chmod\n", case_name); exit(1); }
	policy_host_fd = host_root_fd();
	cwd_path = sys;

	/* THE AXIS IS REAL: a 0700 directory has NO group or other execute bit,
	 * so a caller that is not its owner cannot traverse it — which is the
	 * whole reason the floor exists. */
	CHECK(fstatat(policy_host_fd, policy_rel(mid), &raw, 0) == 0, "the chain link is there");
	CHECK((raw.st_mode & 0111) == 0100,
	      "and is 0700-shaped: owner-execute only, no group or other search (mode %o)",
	      (unsigned)(raw.st_mode & 07777));

	for (g = 0; g < 3; g++) {
		const char *chain[4];
		int i;

		geometry(g, box, sys);
		chain[0] = "/";
		chain[1] = box;
		chain[2] = mid;
		chain[3] = sys;

		for (i = 0; i < 4; i++) {
			enum tier t = resolve_class(chain[i], VIEW_HOST);
			struct stat st;

			CHECK(t != T_PROJECT,
			      "%s: %s is not the remote tier for an unmarked caller", GEOM_NAME[g], chain[i]);
			if (t == T_SYNTH) {
				CHECK(policy_synth_getattr(chain[i], &st, VIEW_HOST) == 0
				      && (st.st_mode & 0111) == 0111,
				      "%s: %s is the overlay node, and it is traversable",
				      GEOM_NAME[g], chain[i]);
				continue;
			}
			CHECK(t == T_FAIL || t == T_HOST,
			      "%s: %s is served by the orchestrator (%s)",
			      GEOM_NAME[g], chain[i], tier_name(t));
			CHECK(fstatat(policy_host_fd, policy_rel(chain[i]), &st, 0) == 0,
			      "%s: and the orchestrator really has %s", GEOM_NAME[g], chain[i]);
			policy_floor_traversal(chain[i], &st, VIEW_HOST);
			CHECK((st.st_mode & 0111) == 0111,
			      "%s: the floor makes %s traversable for every uid (mode %o)",
			      GEOM_NAME[g], chain[i], (unsigned)(st.st_mode & 07777));
		}
		/* THE INTERVENING COMPONENT, named on its own so a loop that
		 * skipped it cannot read as a pass: at M it carries an EXACT
		 * project pin, at W it is covered by prefix match, and at N it
		 * carries none. */
		CHECK(resolve_class(mid, VIEW_CLI) == (g == 0 ? T_SYNTH : T_PROJECT),
		      "%s: VIEW_CLI at the intervening component is %s — the geometry is really built",
		      GEOM_NAME[g], tier_name(resolve_class(mid, VIEW_CLI)));
	}

	close(policy_host_fd);
	policy_host_fd = -1;
	cwd_path = NULL;
	hrm(box, "/home");
	rmdir(box);
}

/* ── B40: the marked CLI's resolution is untouched ──────────────────────── */
/*
 * CONSTRAINT 5. `VIEW_CLI` is the tier table as written, at every geometry, and
 * the expectations below are SPELLED OUT rather than derived from
 * `resolve_class` — a derivation from the function under test would survive any
 * mutation of it.
 */
static void b40_marked_is_untouched(void)
{
	char box[] = "/tmp/cc-policy-b40XXXXXX";
	char sys[PATH_MAX], leaf[PATH_MAX];
	int g;

	host_box(box);
	hjoin(sys, sizeof(sys), box, "/srv2");
	hjoin(leaf, sizeof(leaf), box, "/srv2/src/x.ts");
	policy_host_fd = host_root_fd();
	cwd_path = sys;

	for (g = 0; g < 3; g++) {
		geometry(g, box, sys);
		/* THE PROJECT ITSELF IS THE REMOTE TIER AT ALL THREE. */
		CHECK(resolve_class(sys, VIEW_CLI) == T_PROJECT,
		      "%s: the project root is the remote tier to the CLI", GEOM_NAME[g]);
		CHECK(resolve_class(leaf, VIEW_CLI) == T_PROJECT,
		      "%s: and so is a file inside it", GEOM_NAME[g]);
		/* THE SPACE ABOVE IT IS WHERE THE GEOMETRY SHOWS, and the CLI
		 * still sees exactly what `buildTierTable` wrote. */
		CHECK(resolve_class(box, VIEW_CLI) == (g == 0 ? T_SYNTH : T_PROJECT),
		      "%s: the directory above the project is %s to the CLI",
		      GEOM_NAME[g], g == 0 ? "a synthetic ancestor" : "the remote tier");
		CHECK(resolve_class("/", VIEW_CLI) == (g == 2 ? T_PROJECT : T_SYNTH),
		      "%s: and / is %s", GEOM_NAME[g], g == 2 ? "the remote tier" : "a synthetic ancestor");
		/* AND THE REST OF THE TABLE IS UNMOVED. */
		CHECK(resolve_class("/etc/hostname", VIEW_CLI) == T_HOST, "%s: host pin", GEOM_NAME[g]);
		CHECK(resolve_class("/run/cc-union-scaffold", VIEW_CLI) == T_HIDE, "%s: hide pin", GEOM_NAME[g]);
		CHECK(resolve_class("/proc", VIEW_CLI) == T_BIND, "%s: bind pin", GEOM_NAME[g]);
		/* `/var/lib/nothing-pinned` and not `/tmp`: the box lives under
		 * /tmp, so /tmp is an ANCESTOR of the project pin at N and M and
		 * would answer T_SYNTH. An unpinned path must be off every
		 * ancestor chain for this row to say what it means. */
		CHECK(resolve_class("/var/lib/nothing-pinned", VIEW_CLI) == (g == 2 ? T_PROJECT : T_FAIL),
		      "%s: and an unpinned path outside the mirror root is fail", GEOM_NAME[g]);
		/* THE MARK STILL SELECTS IT: a marked caller takes the identity
		 * map at every tier, so nothing above can be re-routed. */
		CHECK(policy_caller_tier("getattr", sys, T_PROJECT, 1, 600) == T_PROJECT,
		      "%s: and a MARKED caller keeps the remote tier", GEOM_NAME[g]);
	}

	close(policy_host_fd);
	policy_host_fd = -1;
	cwd_path = NULL;
	rmdir(box);
}

/* ── B41: no unmarked resolution can name the remote ────────────────────── */
/*
 * CONSTRAINT 3, STRUCTURALLY. Over the same path set × three geometries,
 * `VIEW_HOST` never yields T_PROJECT — so `policy_project_route` is unreachable
 * from an unmarked caller, no control frame can be sent on its behalf and the
 * mirror cannot be read. It holds WITHOUT consulting the host at all.
 *
 * AND THE RE-RESOLUTION'S RANGE, WHICH IS {T_HOST, T_SYNTH, T_FAIL, T_HIDE}.
 * Striking a `project` pin hands the
 * longest-prefix contest to whatever SHORTER pin covers the path, and a `hide`
 * pin is eligible to win it — so a path under a `hide` pin and a LONGER
 * `project` pin is T_PROJECT to the CLI and T_HIDE to everyone else. That is
 * the correct answer (hidden stays hidden, and `route()`'s T_HIDE arm answers
 * -ENOENT before anything else), and this case builds the overlap deliberately
 * and asserts all four.
 */
static void b41_no_unmarked_resolution_names_the_remote(void)
{
	char box[] = "/tmp/cc-policy-b41XXXXXX";
	char sys[PATH_MAX], leaf[PATH_MAX];
	char hidden[PATH_MAX], hidden_pin[PATH_MAX + 16], inner_pin[PATH_MAX + 24];
	char inner[PATH_MAX];
	const char *extra[3];
	const char *paths[9];
	int g, i, n_checked = 0, n_synth = 0, n_fail = 0, n_hide = 0;

	host_box(box);
	hjoin(sys, sizeof(sys), box, "/srv2");
	hjoin(leaf, sizeof(leaf), box, "/srv2/src/x.ts");
	/* THE OVERLAP: a `hide` prefix with a LONGER `project` pin inside it, and
	 * the checked path under both. */
	hjoin(hidden, sizeof(hidden), box, "/hidden");
	hjoin(inner, sizeof(inner), box, "/hidden/inner/f.txt");
	snprintf(hidden_pin, sizeof(hidden_pin), "hide\t%s", hidden);
	snprintf(inner_pin, sizeof(inner_pin), "project\t%s/inner", hidden);
	extra[0] = hidden_pin;
	extra[1] = inner_pin;
	extra[2] = NULL;
	policy_host_fd = host_root_fd();
	cwd_path = sys;

	paths[0] = "/";
	paths[1] = box;
	paths[2] = sys;
	paths[3] = leaf;
	paths[4] = "/etc/hostname";
	paths[5] = "/tmp";
	paths[6] = "/run/cc-union-scaffold";
	paths[7] = "/proc";
	paths[8] = inner;

	for (g = 0; g < 3; g++) {
		geometry_ex(g, box, sys, extra);
		for (i = 0; i < 9; i++) {
			enum tier host = resolve_class(paths[i], VIEW_HOST);

			CHECK(host != T_PROJECT,
			      "%s: %s cannot be the remote tier unmarked (%s)",
			      GEOM_NAME[g], paths[i], tier_name(host));
			/* THE RE-RESOLUTION'S RANGE, at every path whose VIEW_CLI
			 * tier is one policy_caller_tier re-resolves. */
			if (policy_tier_is_caller_sensitive(resolve_class(paths[i], VIEW_CLI))
			    && resolve_class(paths[i], VIEW_CLI) != T_FAIL) {
				CHECK(host == T_HOST || host == T_SYNTH
				      || host == T_FAIL || host == T_HIDE,
				      "%s: %s re-resolves inside {host, synth, fail, hide} (%s)",
				      GEOM_NAME[g], paths[i], tier_name(host));
				n_checked++;
				if (host == T_SYNTH) n_synth++;
				if (host == T_FAIL)  n_fail++;
				if (host == T_HIDE)  n_hide++;
			}
			/* AND THE MAP ITSELF NEVER HANDS BACK THE REMOTE. */
			CHECK(policy_caller_tier("getattr", paths[i],
						 resolve_class(paths[i], VIEW_CLI), 0, 500) != T_PROJECT,
			      "%s: and policy_caller_tier does not either at %s", GEOM_NAME[g], paths[i]);
		}
		/* THE OVERLAP, ASSERTED ON ITS OWN so it cannot be lost inside the
		 * disjunction above — and BOTH halves, because a case where the
		 * VIEW_CLI tier were not T_PROJECT would never reach the
		 * re-resolution and would prove nothing about its range. */
		CHECK(resolve_class(inner, VIEW_CLI) == T_PROJECT,
		      "%s: the overlap path is the remote tier to the CLI (%s)",
		      GEOM_NAME[g], tier_name(resolve_class(inner, VIEW_CLI)));
		CHECK(resolve_class(inner, VIEW_HOST) == T_HIDE,
		      "%s: and T_HIDE once the project pin is struck — the shorter hide pin wins "
		      "the contest (%s)", GEOM_NAME[g], tier_name(resolve_class(inner, VIEW_HOST)));
		/* AND THE MAP CARRIES IT THROUGH UNCHANGED, so route()'s T_HIDE arm
		 * answers -ENOENT: hidden stays hidden for an unmarked caller, which
		 * is what keeps the mirror and the control socket unreachable. */
		CHECK(policy_caller_tier("getattr", inner, T_PROJECT, 0, 500) == T_HIDE,
		      "%s: policy_caller_tier hands back T_HIDE, not a substitution", GEOM_NAME[g]);
	}
	/* NON-VACUITY: the re-resolution was really exercised, and it really
	 * produced more than one member of the range — including the fourth. */
	CHECK(n_checked >= 12, "the re-resolution was driven at least twelve times (%d)", n_checked);
	CHECK(n_synth >= 3, "and landed on the overlay node at least once per geometry (%d)", n_synth);
	CHECK(n_fail >= 3, "and on fail at least once per geometry (%d)", n_fail);
	CHECK(n_hide == 3, "and on HIDE once per geometry (%d)", n_hide);

	close(policy_host_fd);
	policy_host_fd = -1;
	cwd_path = NULL;
	rmdir(box);
}

/* ── B43: an uncovered path is still the host's, at every geometry ──────── */
/*
 * `fail -> host` IS UNTOUCHED AND UNCONDITIONAL — the rule real-gate arm
 * R13(f) depends on. Driven for an unpinned FILE and for an unpinned
 * directory that is NOT a chain component, so the overlay cannot be what makes
 * it pass, and on both host axes so the probe cannot be either.
 */
static void b43_uncovered_is_still_the_hosts(void)
{
	char box[] = "/tmp/cc-policy-b43XXXXXX";
	char sys[PATH_MAX], loose[PATH_MAX], absent[PATH_MAX];
	int g;

	host_box(box);
	hmkdir(box, "/loose");
	hfile(box, "/loose/f");
	hjoin(sys, sizeof(sys), box, "/srv2");
	hjoin(loose, sizeof(loose), box, "/loose");
	hjoin(absent, sizeof(absent), box, "/loose/nothing-here");
	policy_host_fd = host_root_fd();
	cwd_path = sys;

	for (g = 0; g < 3; g++) {
		geometry(g, box, sys);
		CHECK(policy_cwd_component(loose) == 0, "%s: the probe dir is OFF the chain", GEOM_NAME[g]);
		CHECK(resolve_class(loose, VIEW_HOST) == T_FAIL,
		      "%s: an unpinned directory off the chain is fail", GEOM_NAME[g]);
		CHECK(policy_caller_tier("getattr", loose, T_FAIL, 0, 500) == T_HOST,
		      "%s: and fail is host for an unmarked caller", GEOM_NAME[g]);
		/* UNCONDITIONAL: the host does not have this one, and it is
		 * STILL host — which is what keeps the unmarked CREATE at an
		 * unpinned path alive (R13(f)). */
		CHECK(policy_host_absent(absent) == 1, "%s: the host really lacks it", GEOM_NAME[g]);
		CHECK(policy_caller_tier("getattr", absent, T_FAIL, 0, 500) == T_HOST,
		      "%s: an unpinned path the host LACKS is host too — the rule is not gated",
		      GEOM_NAME[g]);
	}

	close(policy_host_fd);
	policy_host_fd = -1;
	cwd_path = NULL;
	hrm(box, "/loose/f");
	hrm(box, "/loose");
	rmdir(box);
}

/* ── B44: a directory names what the resolving view can open ────────────── */
/*
 * THE DEFECT CLASS THIS CASE KILLS, AND IT RUNS AT THE DEFAULT NARROW ROOT —
 * where a regression would be least visible. The regression looks like this: an
 * unmarked `ls` of a directory reached through `fail -> host` emits NOTHING
 * while `cat` on its children returns their bytes, and a `fail`-pinned child of
 * a host-pinned real directory is omitted from the listing while `cat` on it
 * works.
 *
 * THE PROJECT ROW IS THE ONE THAT READS ODDLY AND IS STATED PLAINLY: a
 * project-pinned child is visible in BOTH views — as the remote's name to the
 * CLI, and as the HOST's name to everyone else, because `VIEW_HOST` strikes the
 * pin and `fail -> host` then serves it. What is `VIEW_CLI`-only is the TIER
 * VALUE T_PROJECT, which `VIEW_HOST` cannot produce at all; that is `b41`'s.
 */
static void b44_dirent_visible(void)
{
	/* THE DEFAULT NARROW ROOT: mirrorRoot == systemPath. */
	pin("project\t/root/srv2");
	pin("host\t/etc");
	pin("fail\t/etc/excluded");
	pin("hide\t/run/cc-union-scaffold");
	pin("bind\t/proc");
	anc_build();
	cwd_path = "/root/srv2";

	/* T_HIDE — INVISIBLE TO EVERYONE. It is what keeps the mirror and cc's
	 * control socket unreachable, and it is the one subtraction constraint 3
	 * forces on constraint 2. */
	CHECK(policy_dirent_visible("/run/cc-union-scaffold", VIEW_CLI) == 0,
	      "a `hide` child is invisible to the CLI");
	CHECK(policy_dirent_visible("/run/cc-union-scaffold", VIEW_HOST) == 0,
	      "and to everyone else — the one name neither view may list");

	/* T_FAIL — INVISIBLE TO THE CLI, whose every op at such a
	 * name answers -ENOENT; visible to everyone else, because `fail -> host`
	 * serves it unconditionally. Both instances: an EXPLICIT `fail` pin, and
	 * a name no pin covers at all. */
	CHECK(policy_dirent_visible("/etc/excluded", VIEW_CLI) == 0,
	      "an excluded child is invisible to the CLI: its every op answers -ENOENT");
	CHECK(policy_dirent_visible("/etc/excluded", VIEW_HOST) == 1,
	      "and VISIBLE to everyone else, who can open it (the exclude instance)");
	CHECK(policy_dirent_visible("/tmp/loose", VIEW_CLI) == 0,
	      "an unpinned child is invisible to the CLI");
	CHECK(policy_dirent_visible("/tmp/loose", VIEW_HOST) == 1,
	      "and visible to everyone else (the unpinned instance)");

	/* HOST, BIND — VISIBLE TO BOTH: neither view strikes them. */
	CHECK(policy_dirent_visible("/etc/hosts", VIEW_CLI) == 1, "a host child is visible to the CLI");
	CHECK(policy_dirent_visible("/etc/hosts", VIEW_HOST) == 1, "and to everyone else");
	CHECK(policy_dirent_visible("/proc", VIEW_CLI) == 1, "a bind target is visible to the CLI");
	CHECK(policy_dirent_visible("/proc", VIEW_HOST) == 1, "and to everyone else");

	/* SYNTH — the ancestor in VIEW_CLI, the host's own directory in
	 * VIEW_HOST. Visible either way, for two different reasons. */
	CHECK(resolve_class("/root", VIEW_CLI) == T_SYNTH, "/root is a synthetic ancestor to the CLI");
	CHECK(policy_dirent_visible("/root", VIEW_CLI) == 1, "and it is listed");
	CHECK(policy_dirent_visible("/root", VIEW_HOST) == 1,
	      "and to everyone else it is the orchestrator's own directory, also listed");

	/* PROJECT — visible to both, and the tier value is the CLI's alone. */
	CHECK(resolve_class("/root/srv2", VIEW_CLI) == T_PROJECT, "the project root is T_PROJECT to the CLI");
	CHECK(policy_dirent_visible("/root/srv2", VIEW_CLI) == 1, "and the CLI may list it");
	CHECK(resolve_class("/root/srv2", VIEW_HOST) != T_PROJECT,
	      "VIEW_HOST cannot produce T_PROJECT at all");
	CHECK(policy_dirent_visible("/root/srv2", VIEW_HOST) == 1,
	      "and everyone else sees the name too — as the host's, not the remote's");

	/* AND `policy_synth_children` ASKS THE SAME PREDICATE, so the two arms
	 * cannot drift: the `fail`-pinned child is absent from the CLI's listing
	 * of /etc and present in everyone else's. */
	{
		size_t n_cli, n_host, i;
		int cli_named = 0, host_named = 0;

		nlisted = 0;
		n_cli = policy_synth_children("/etc", VIEW_CLI, collect, NULL);
		for (i = 0; i < nlisted; i++)
			if (!strcmp(listed[i], "excluded")) cli_named = 1;
		CHECK(cli_named == 0, "policy_synth_children omits the excluded child for the CLI");
		nlisted = 0;
		n_host = policy_synth_children("/etc", VIEW_HOST, collect, NULL);
		for (i = 0; i < nlisted; i++)
			if (!strcmp(listed[i], "excluded")) host_named = 1;
		CHECK(host_named == 1, "and names it for everyone else");
		CHECK(n_host == n_cli + 1, "exactly one name differs (%zu vs %zu)", n_host, n_cli);
	}
	cwd_path = NULL;
}

/* ── B46: the floor's SCOPE ─────────────────────────────────────────────── */
/*
 * PINS: the floor fires ONLY on a `VIEW_HOST` DIRECTORY that is a cwd-chain
 * component. Not on a file, not off the chain, not for `VIEW_CLI`.
 *
 * THE SCOPE IS WHAT MAKES CONSTRAINT 1 MORE EXACTLY SATISFIED, NOT LESS: an
 * unscoped floor would grant traversal the host itself denies, which is more
 * than "what that uid would normally be able to do". Everything off the chain
 * keeps its real mode.
 */
static void b46_floor_scope(void)
{
	struct stat dir, file;

	cwd_path = "/root/srv2";
	memset(&dir, 0, sizeof(dir));
	dir.st_mode = S_IFDIR | 0700;
	memset(&file, 0, sizeof(file));
	file.st_mode = S_IFREG | 0600;

	CHECK(policy_floor_applies("/root", dir.st_mode, VIEW_HOST) == 1,
	      "a VIEW_HOST directory on the chain is floored");
	CHECK(policy_floor_applies("/root", dir.st_mode, VIEW_CLI) == 0,
	      "the MARKED CLI's view is never floored — it gets the real mode");
	CHECK(policy_floor_applies("/root", file.st_mode, VIEW_HOST) == 0,
	      "a FILE on the chain is not: the floor grants path resolution, and a file is not a link");
	CHECK(policy_floor_applies("/root/other", dir.st_mode, VIEW_HOST) == 0,
	      "a directory OFF the chain keeps its real mode");
	CHECK(policy_floor_applies("/root/srv2/sub", dir.st_mode, VIEW_HOST) == 0,
	      "and so does a directory BELOW the cwd — the chain is upward only");
	CHECK(policy_floor_applies("/root/srv", dir.st_mode, VIEW_HOST) == 0,
	      "and the prefix-sharing sibling is not on the chain either");

	/* THE EFFECT ITSELF, AND ITS EXTENT: exactly the three execute bits,
	 * and nothing else in the stat. */
	{
		struct stat st = dir;
		policy_floor_traversal("/root", &st, VIEW_HOST);
		CHECK(st.st_mode == (dir.st_mode | 0111),
		      "the floor sets exactly 0111 and changes nothing else (%o -> %o)",
		      (unsigned)dir.st_mode, (unsigned)st.st_mode);
		st = dir;
		policy_floor_traversal("/root/other", &st, VIEW_HOST);
		CHECK(st.st_mode == dir.st_mode, "and off the chain it changes nothing at all");
		st = file;
		policy_floor_traversal("/root", &st, VIEW_HOST);
		CHECK(st.st_mode == file.st_mode, "nor on a file");
	}

	/* THE OVERLAY NODE IS ALREADY 0555 AND THE FLOOR IS A NO-OP ON IT — the
	 * two mechanisms do not compound. */
	{
		struct stat st;
		policy_fixed_dir(&st, 0555, 1);
		policy_floor_traversal("/root/srv2", &st, VIEW_HOST);
		CHECK((st.st_mode & 07777) == 0555, "the overlay node is unchanged by the floor");
	}
	cwd_path = NULL;
}

/* ── B47: the floor is applied at EVERY op that reports permission ──────── */
/*
 * §5.4'S ENUMERATION, AND THE SEAM-INSIDE-A-SEAM IT EXISTS TO CLOSE. The four
 * reporting ops are `pt_getattr`'s path arm, `pt_getattr`'s fh arm,
 * `pt_readdir`'s per-child stat and `pt_access`. The first three hold a
 * `struct stat` and go through `policy_floor_traversal`; `pt_access` holds a
 * mask and goes through `policy_floor_mask`. WHICH OP BODIES CALL THEM is a
 * source-shape assertion in tests/fuse-union-policy.test.mjs — no fixture can
 * reach a libfuse op body. What is pinned HERE is that the two entry points
 * AGREE, which is the property an omission would break:
 *
 *   `stat` and `fstat` see the same mode, because both are the same function
 *   over the same stat; the readdir child stat, whose mode is only the type
 *   bits from `d_type`, gains the same three bits; and `access(X_OK)` answers
 *   the mode those three report while `access(R_OK)` is still referred to the
 *   host. Without the last of those, `test -x /root` and `stat /root` disagree
 *   from one caller — the exact defect class this filesystem exists to remove.
 */
static void b47_floor_is_applied_at_every_reporting_op(void)
{
	char box[] = "/tmp/cc-policy-b47XXXXXX";
	char mid[PATH_MAX], off[PATH_MAX];
	struct stat path_arm, fh_arm, child;

	host_box(box);
	hmkdir(box, "/home");
	hmkdir(box, "/other");
	hjoin(mid, sizeof(mid), box, "/home");
	hjoin(off, sizeof(off), box, "/other");
	if (chmod(mid, 0700) != 0) { printf("FAIL %s: chmod\n", case_name); exit(1); }
	policy_host_fd = host_root_fd();
	cwd_path = mid;                        /* the chain ends AT the 0700 link */

	/* THE THREE STAT-SHAPED SITES, each fed the stat its own op would hold. */
	CHECK(fstatat(policy_host_fd, policy_rel(mid), &path_arm, AT_SYMLINK_NOFOLLOW) == 0,
	      "pt_getattr's path arm: the host's own stat");
	fh_arm = path_arm;                     /* pt_getattr's fh arm: an fstat of the same node */
	memset(&child, 0, sizeof(child));
	/* pt_readdir hands filler() a stat whose mode is `d_type << 12` and
	 * nothing else; for a directory that is exactly S_IFDIR, with no
	 * permission bits at all. */
	child.st_mode = S_IFDIR;

	policy_floor_traversal(mid, &path_arm, VIEW_HOST);
	policy_floor_traversal(mid, &fh_arm, VIEW_HOST);
	policy_floor_traversal(mid, &child, VIEW_HOST);

	CHECK(path_arm.st_mode == fh_arm.st_mode,
	      "stat and fstat report the SAME mode (%o vs %o) — flooring one arm only is the "
	      "mutant this kills", (unsigned)path_arm.st_mode, (unsigned)fh_arm.st_mode);
	CHECK((path_arm.st_mode & 0111) == 0111, "and it is traversable (%o)",
	      (unsigned)(path_arm.st_mode & 07777));
	CHECK((child.st_mode & 0111) == 0111,
	      "the readdir child stat agrees with both (%o)", (unsigned)(child.st_mode & 07777));
	CHECK(S_ISDIR(child.st_mode), "and is still a directory");

	/* THE FOURTH SITE, WHICH HAS NO STAT: the mask `pt_access` hands the
	 * host. X_OK is granted where the mode above says it is; R_OK is
	 * untouched, so the host still answers for the read. */
	CHECK(policy_floor_mask(mid, X_OK, VIEW_HOST) == 0,
	      "access(X_OK) is granted outright — it agrees with the mode stat reported");
	CHECK(policy_floor_mask(mid, R_OK, VIEW_HOST) == R_OK,
	      "access(R_OK) is referred to the host unchanged — the floor grants resolution, not access");
	CHECK(policy_floor_mask(mid, R_OK | X_OK, VIEW_HOST) == R_OK,
	      "and a combined mask keeps exactly the half the host must answer");
	CHECK(policy_floor_mask(mid, W_OK, VIEW_HOST) == W_OK, "a write probe is untouched");
	/* F_OK IS 0, and the mask must come back 0 UNCHANGED rather than as a
	 * grant — union.c's call site distinguishes the two, and conflating them
	 * would answer "it exists" for every existence probe on the chain. */
	CHECK(policy_floor_mask(mid, F_OK, VIEW_HOST) == F_OK,
	      "an existence probe is unchanged, so the host is still asked");

	/* AND THE SCOPE HOLDS AT THIS ENTRY POINT TOO. */
	CHECK(policy_floor_mask(off, X_OK, VIEW_HOST) == X_OK,
	      "off the chain the mask is untouched");
	CHECK(policy_floor_mask(mid, X_OK, VIEW_CLI) == X_OK,
	      "and the marked CLI's access is never floored");

	close(policy_host_fd);
	policy_host_fd = -1;
	cwd_path = NULL;
	hrm(box, "/home");
	hrm(box, "/other");
	rmdir(box);
}

/* ── B48: the absence probe falls NOT ABSENT on an unknown error ────────── */
/*
 * THE FAILURE DIRECTION, WHICH IS THE WHOLE OF THIS PROBE'S RISK. It answers
 * ABSENT only for the errnos that MEAN absence; on anything else — ELOOP from an
 * intermediate symlink, EIO, NFS under root_squash — it answers NOT ABSENT, so
 * no node is synthesized and the path falls to `fail -> host` where the host
 * answers for itself.
 *
 * WHY THAT DIRECTION. Falling ABSENT on an unknown error would place a
 * traverse-only node over a directory the orchestrator may really have, hiding
 * it and its write surface SILENTLY — which is the failure class the ABSENT
 * direction produces. Falling NOT ABSENT breaks `chdir` at that one path,
 * loudly, with an event row naming it. Loud and reversible beats silent and
 * hiding.
 *
 * THE POLARITY IS THE INVERSE OF A `host_has`-SHAPED PROBE, which is why there
 * is only one reader of absence: a has-shaped probe reused at a new call site
 * picks the wrong direction silently.
 */
static void b48_probe_falls_not_absent(void)
{
	char box[] = "/tmp/cc-policy-b48XXXXXX";
	char f[PATH_MAX], d[PATH_MAX], dangle[PATH_MAX], absent[PATH_MAX];
	char under_file[PATH_MAX], loop[PATH_MAX], via_loop[PATH_MAX];
	char toolong[PATH_MAX];
	size_t i;

	host_box(box);
	hfile(box, "/f");
	hmkdir(box, "/d");
	hsymlink(box, "/dangle", "./nothing-here");
	hsymlink(box, "/loop", "loop");                 /* points at itself */
	hjoin(f, sizeof(f), box, "/f");
	hjoin(d, sizeof(d), box, "/d");
	hjoin(dangle, sizeof(dangle), box, "/dangle");
	hjoin(absent, sizeof(absent), box, "/absent");
	hjoin(under_file, sizeof(under_file), box, "/f/under");
	hjoin(loop, sizeof(loop), box, "/loop");
	hjoin(via_loop, sizeof(via_loop), box, "/loop/x");

	/* A NEGATIVE fd ANSWERS 1 — "no host at all", the axis every case that
	 * leaves the seam unset relies on. Asserted at a path that DOES exist,
	 * so it cannot pass by accident. */
	policy_host_fd = -1;
	CHECK(policy_host_absent(f) == 1, "with no host fd the probe answers ABSENT for a file that EXISTS");
	CHECK(policy_host_absent("/") == 1, "and for / as well");

	policy_host_fd = host_root_fd();
	/* PRESENT — NOT ABSENT. */
	CHECK(policy_host_absent(f) == 0, "a present file is not absent");
	CHECK(policy_host_absent(d) == 0, "nor is a present directory");
	CHECK(policy_host_absent("/") == 0, "nor the root itself, via policy_rel's \".\"");
	/* AT_SYMLINK_NOFOLLOW: a DANGLING symlink is an entry, so it is not an
	 * absence and no node is synthesized over it. */
	CHECK(policy_host_absent(dangle) == 0, "and a DANGLING symlink is an entry, not an absence");

	/* THE THREE ABSENCE ERRNOS. */
	CHECK(policy_host_absent(absent) == 1, "ENOENT: a path that is not there IS absent");
	CHECK(policy_host_absent(under_file) == 1,
	      "ENOTDIR: a path under a FILE is absent — it cannot exist at that spelling");
	for (i = 0; i < sizeof(toolong) - 1; i++)
		toolong[i] = i == 0 ? '/' : 'x';
	toolong[sizeof(toolong) - 1] = '\0';
	CHECK(policy_host_absent(toolong) == 1, "ENAMETOOLONG: and neither can an over-long one");

	/* AND THE ONE THAT IS NOT AN ABSENCE. An intermediate symlink loop
	 * raises ELOOP while an entry at the final spelling may well exist —
	 * AT_SYMLINK_NOFOLLOW spares only the FINAL component — so ELOOP is not
	 * a statement about the entry, and the probe must not read it as one. */
	{
		struct stat st;
		errno = 0;
		CHECK(fstatat(policy_host_fd, policy_rel(via_loop), &st, AT_SYMLINK_NOFOLLOW) == -1
		      && errno == ELOOP,
		      "the fixture really produces ELOOP (errno %d)", errno);
	}
	CHECK(policy_host_absent(via_loop) == 0,
	      "ELOOP is NOT an absence: the probe falls NOT ABSENT, so no node hides the host");

	close(policy_host_fd);
	policy_host_fd = -1;
	hrm(box, "/f");
	hrm(box, "/d");
	hrm(box, "/dangle");
	hrm(box, "/loop");
	rmdir(box);
}

/* ── B49: a table-derived name exists only if this view can open it ─────── */
/*
 * THE SECOND HALF OF THE DIRENT RULE, AND IT IS NOT `policy_dirent_visible`.
 * That predicate answers "may this view SEE this name". This one answers "is
 * there anything there at all" — and conflating them produces three separate
 * `ls`/`cat` disagreements:
 *
 *   an `exclude` under the project put a name into an unmarked listing of the
 *   overlay cwd while every op on it answered -ENOENT;
 *   a project-pinned child resolving to the OVERLAY was host-checked, found
 *   absent and dropped, so `stat <systemPath>` answered and `cd` worked while
 *   `ls` of its parent omitted the name; and
 *   an off-chain host-absent ANCESTOR was emitted unchecked, which is true of a
 *   VIEW_CLI scaffold node and false in VIEW_HOST.
 *
 * THE RULE IS ONE SENTENCE: a fixed node exists by construction, and everything
 * else exists exactly where the orchestrator has it. What makes it view-shaped
 * is that WHICH paths are fixed nodes differs between the views — the ancestor
 * table in VIEW_CLI, the cwd overlay in VIEW_HOST.
 */
static void b49_table_child_exists(void)
{
	char box[] = "/tmp/cc-policy-b49XXXXXX";
	char sys[PATH_MAX], line[PATH_MAX + 32];
	char excluded[PATH_MAX], hostpin[PATH_MAX], hostgone[PATH_MAX];
	char anc_absent[PATH_MAX], anc_gone[PATH_MAX];

	host_box(box);
	hjoin(sys, sizeof(sys), box, "/srv2");           /* the cwd; NEVER created */
	hjoin(excluded, sizeof(excluded), box, "/srv2/node_modules");
	hjoin(hostpin, sizeof(hostpin), box, "/present");
	hjoin(hostgone, sizeof(hostgone), box, "/gone");
	hjoin(anc_absent, sizeof(anc_absent), box, "/absent-anc/leaf");
	hjoin(anc_gone, sizeof(anc_gone), box, "/absent-anc");
	hmkdir(box, "/present");

	npins = 0;
	snprintf(line, sizeof(line), "project\t%s", sys);            pin(line);
	snprintf(line, sizeof(line), "fail\t%s", excluded);          pin(line);
	snprintf(line, sizeof(line), "host\t%s", hostpin);           pin(line);
	snprintf(line, sizeof(line), "host\t%s", hostgone);          pin(line);
	snprintf(line, sizeof(line), "host\t%s", anc_absent);        pin(line);
	pin("bind\t/proc");
	anc_build();
	cwd_path = sys;
	policy_host_fd = host_root_fd();

	/* THE AXES ARE REAL, asserted before anything leans on them. */
	CHECK(policy_host_absent(sys) == 1, "the orchestrator has nothing at the cwd");
	CHECK(policy_host_absent(hostpin) == 0, "and does have the present host pin");
	CHECK(policy_host_absent(hostgone) == 1, "and nothing at the absent one");
	CHECK(resolve_class(sys, VIEW_HOST) == T_SYNTH, "so the cwd is the overlay node");

	/* ── (1) THE EXCLUDE UNDER THE OVERLAY. `policy_dirent_visible` says an
	 *    unmarked caller MAY see a `fail` name — and there is nothing there,
	 *    because the orchestrator has nothing at the parent either. Both
	 *    predicates are driven, so the case pins that they answer DIFFERENTLY
	 *    rather than that one of them subsumes the other. */
	CHECK(policy_dirent_visible(excluded, VIEW_HOST) == 1,
	      "an excluded name is VISIBLE to an unmarked caller — fail -> host serves it");
	CHECK(policy_table_child_exists(excluded, VIEW_HOST, 0) == 0,
	      "but nothing is THERE, so it must not be emitted: the orchestrator has nothing "
	      "under a path it has nothing at");

	/* ── (2) THE PROJECT-PINNED CHILD THAT IS THE OVERLAY. Visible, and it
	 *    EXISTS — the node is fixed. Dropping it is the regression where
	 *    `cd <systemPath>` worked and `ls` of its parent omitted the name. */
	CHECK(policy_dirent_visible(sys, VIEW_HOST) == 1, "the cwd is a visible child of its parent");
	CHECK(policy_table_child_exists(sys, VIEW_HOST, 0) == 1,
	      "and it EXISTS as the overlay node, though the orchestrator has nothing there");
	CHECK(policy_host_absent(sys) == 1,
	      "— asserted again here, so the row above cannot pass by the host happening to have it");

	/* ── (3) THE ANCESTOR, WHICH IS A FIXED NODE IN ONE VIEW AND NOTHING IN
	 *    THE OTHER. `<box>/absent-anc` is a strict ancestor of a host pin and
	 *    the orchestrator has neither. */
	{
		const char *anc = anc_gone;
		CHECK(anc_find(anc) >= 0, "the ancestor is really in the table");
		CHECK(policy_host_absent(anc) == 1, "and the orchestrator really lacks it");
		CHECK(resolve_class(anc, VIEW_CLI) == T_SYNTH, "VIEW_CLI: a scaffold node");
		CHECK(policy_table_child_exists(anc, VIEW_CLI, 0) == 1,
		      "which exists by construction — the scaffold is what makes the pin reachable");
		CHECK(resolve_class(anc, VIEW_HOST) == T_FAIL,
		      "VIEW_HOST: the ancestor table is not consulted, so it is fail");
		CHECK(policy_table_child_exists(anc, VIEW_HOST, 0) == 0,
		      "and fail -> host answers -ENOENT, so it must not be emitted");
	}

	/* ── (4) THE ORDINARY HOST PIN, BOTH WAYS, IN BOTH VIEWS. */
	CHECK(policy_table_child_exists(hostpin, VIEW_CLI, 0) == 1, "a present host pin exists to the CLI");
	CHECK(policy_table_child_exists(hostpin, VIEW_HOST, 0) == 1, "and to everyone else");
	CHECK(policy_table_child_exists(hostgone, VIEW_CLI, 0) == 0,
	      "an ABSENT host pin does not — this is the `ls /etc` listing ld.so.preload defect");
	CHECK(policy_table_child_exists(hostgone, VIEW_HOST, 0) == 0, "in either view");

	/* ── (5) A BIND TARGET IS A FIXED NODE TOO, in both views: `route()` serves
	 *    it whether or not the orchestrator has the path, so a listing that
	 *    omitted it would disagree with `stat`. */
	CHECK(policy_table_child_exists("/proc", VIEW_CLI, 0) == 1, "a bind target exists to the CLI");
	CHECK(policy_table_child_exists("/proc", VIEW_HOST, 0) == 1, "and to everyone else");

	/* ── (6) AND THE PROJECT TIER, TO THE CLI, IS STILL THE HOST QUESTION ON A
	 *    REAL DIRECTORY'S MERGE — the rule is view-shaped because WHICH paths
	 *    are fixed nodes differs, not because the sentence does. A project child the
	 *    orchestrator lacks is not in the mirror either, which is what the real
	 *    arm's backing stream already said. */
	CHECK(resolve_class(sys, VIEW_CLI) == T_PROJECT, "the cwd is the remote tier to the CLI");
	CHECK(policy_table_child_exists(sys, VIEW_CLI, 0) == 0,
	      "and to the CLI it is a host question, answered no — the rule is view-shaped because "
	      "WHICH paths are fixed nodes differs, not because the sentence does");

	/* ── (7) THE SCAFFOLD AXIS, WHICH IS A CARVE-OUT OF TWO PARTS AND NOT OF
	 *    ONE. On a node with NO BACKING STORE the host is the WRONG AXIS for a
	 *    `project` child: a project path's existence to the CLI is the MIRROR's
	 *    question, BY TIER, wherever the host happens to hold it — and the right
	 *    channel is a control frame a synthetic node must not send. The axis is
	 *    the argument, NOT "the orchestrator has nothing at systemPath": this
	 *    fixture's own box makes the host-absent case, but that case is
	 *    deployment- and geometry-conditional in production and the carve-out
	 *    does not rest on it. It does NOT reach a `host` pin child of the same
	 *    node, where the host IS the right axis and the probe costs one fstatat.
	 *    Both halves are driven, because a case that drove only the first would
	 *    license the flag skipping every check. */
	CHECK(policy_table_child_exists(sys, VIEW_CLI, 1) == 1,
	      "a `project` child of a scaffold node is taken on trust — the host is the wrong axis, "
	      "and this is what keeps the project in the marked `ls` of its parent at every geometry");
	CHECK(policy_table_child_exists(hostgone, VIEW_CLI, 1) == 0,
	      "but a `host` pin child of that SAME node is still checked, and an absent one is not "
	      "emitted — the marked `ls /etc` naming an ETC_PINS entry `cat` answers -ENOENT for");
	CHECK(policy_table_child_exists(hostpin, VIEW_CLI, 1) == 1,
	      "while a present one is");
	CHECK(policy_table_child_exists(anc_gone, VIEW_CLI, 1) == 1,
	      "and a fixed node is unaffected by the flag — it exists by construction either way");
	/* AND THE FLAG IS INERT IN VIEW_HOST, because that view cannot produce
	 * T_PROJECT at all — asserted rather than assumed, so a later widening of
	 * the carve-out cannot hide behind it. */
	CHECK(resolve_class(sys, VIEW_HOST) != T_PROJECT, "VIEW_HOST cannot produce T_PROJECT");
	CHECK(policy_table_child_exists(hostgone, VIEW_HOST, 1)
	      == policy_table_child_exists(hostgone, VIEW_HOST, 0),
	      "so the scaffold flag changes no VIEW_HOST answer");

	close(policy_host_fd);
	policy_host_fd = -1;
	cwd_path = NULL;
	hrm(box, "/present");
	rmdir(box);
}

static void print_vec(const char *label, const char *b, size_t n)
{
	size_t i;
	printf("VEC %s ", label);
	for (i = 0; i < n; i++)
		printf("%02x", (unsigned char)b[i]);
	printf("\n");
}

static void field_vectors(int argc, char **argv)
{
	/* NUL-SEPARATED, exactly as /proc/<pid>/cmdline is, trailing NUL and all.
	 * The middle argument is a `bash -c` script carrying a tab, a newline, a
	 * backslash and two control bytes; the last is a high-bit sequence
	 * followed by a byte that is not valid UTF-8 at all. */
	static const char CMD[] =
		"/bin/bash\0-c\0echo\thi\nthere \\ \x01\x7f done\0\xc3\xa9\xff\0";
	static const size_t CMDLEN = sizeof(CMD) - 1;
	static const char PATHV[] = "/nasty\tpath\nhere";
	/* THE FORGERY, in all three escaped fields at once. No trailing NUL on the
	 * cmdline — a capped read has none either, which is the shape that puts a
	 * `\!truncated` spelling at the very end of a field. */
	static const char FPATH[] = "/f-forge/\\!truncated";
	static const char FCOMM[] = "\\!truncated";
	static const char FCMD[]  = "arg\0tail\\!truncated";
	static const size_t FCMDLEN = sizeof(FCMD) - 1;
	static char big[POLICY_CMDLINE_MAX + 1024];
	size_t i, start;
	FILE *f;

	if (argc < 3) { fprintf(stderr, "field-vectors: needs a log path\n"); exit(2); }
	if (!(f = fopen(argv[2], "w"))) { fprintf(stderr, "field-vectors: fopen\n"); exit(2); }
	event_fp = f;
	setvbuf(event_fp, NULL, _IOLBF, 0);

	/* 1. an ordinary argv, every byte class in it */
	proc_set(9001, 9001, 77);
	proc_set_identity(9001, "bash", CMD, CMDLEN);
	policy_event(EV_DENY, "getattr", PATHV, "unpinned-fail-closed", 9001);
	/* 2. the forgery */
	proc_set(9002, 9002, 78);
	proc_set_identity(9002, FCOMM, FCMD, FCMDLEN);
	policy_event(EV_DENY, "getattr", FPATH, "unpinned-fail-closed", 9002);
	/* 3, 4. the two absences that are not `gone` */
	proc_set(9003, 9003, 79);
	proc_set_identity_fail(9003, POLICY_PROC_UNREADABLE, POLICY_PROC_UNREADABLE);
	policy_event(EV_DENY, "getattr", "/f-unreadable", "unpinned-fail-closed", 9003);
	proc_set(9004, 9004, 80);
	proc_set_identity(9004, "", "", 0);
	policy_event(EV_DENY, "getattr", "/f-empty", "unpinned-fail-closed", 9004);
	/* 5. a REAL truncation, which is what row 2 must not be confused with */
	memset(big, 'a', sizeof(big));
	proc_set(9005, 9005, 81);
	proc_set_identity(9005, "big", big, sizeof(big));
	policy_event(EV_DENY, "getattr", "/f-trunc", "unpinned-fail-closed", 9005);

	/* THE VECTORS: each argv element and each escaped field, as hex of the RAW
	 * bytes the daemon was given. */
	for (i = 0, start = 0; i <= CMDLEN; i++) {
		if (i < CMDLEN && CMD[i] != '\0') continue;
		if (i == CMDLEN && start == i) break;
		print_vec("argv", CMD + start, i - start);
		start = i + 1;
	}
	print_vec("path", PATHV, sizeof(PATHV) - 1);
	print_vec("comm", "bash", 4);
	print_vec("fpath", FPATH, sizeof(FPATH) - 1);
	print_vec("fcomm", FCOMM, sizeof(FCOMM) - 1);
	for (i = 0, start = 0; i <= FCMDLEN; i++) {
		if (i < FCMDLEN && FCMD[i] != '\0') continue;
		if (i == FCMDLEN && start == i) break;
		print_vec("fargv", FCMD + start, i - start);
		start = i + 1;
	}
	printf("TRUNCLEN %d\n", POLICY_CMDLINE_MAX - 1);
	fclose(event_fp);
	event_fp = NULL;
}

int main(int argc, char **argv)
{
	const char *c = argc > 1 ? argv[1] : "";

	case_name = c;
	seams();

	if      (!strcmp(c, "b0-parse"))      b0_parse();
	else if (!strcmp(c, "b1-prefix"))     b1_prefix();
	else if (!strcmp(c, "b2-failclosed")) b2_failclosed();
	else if (!strcmp(c, "b3-ancestors"))  b3_ancestors();
	else if (!strcmp(c, "b3b-exact-pin")) b3b_exact_pin_wins();
	else if (!strcmp(c, "b4-children"))   b4_children();
	else if (!strcmp(c, "b5-getattr"))    b5_getattr();
	else if (!strcmp(c, "b6-erofs"))      b6_erofs();
	else if (!strcmp(c, "b7-unmarked"))   b7_unmarked();
	else if (!strcmp(c, "b8-reuse"))      b8_reuse();
	else if (!strcmp(c, "b9-tgid-key"))   b9_tgid_key();
	else if (!strcmp(c, "b10-cache-key")) b10_cache_key();
	else if (!strcmp(c, "b11-codec"))     b11_codec();
	else if (!strcmp(c, "b12-errno"))     b12_errno();
	else if (!strcmp(c, "b13-refusals"))  b13_refusals();
	else if (!strcmp(c, "b14-reasons"))   b14_control_reasons();
	else if (!strcmp(c, "b15-unreconcilable")) b15_unreconcilable();
	else if (!strcmp(c, "b16-abandon"))   b16_abandon();
	else if (!strcmp(c, "b19-caller-tier-matrix")) b19_caller_tier_matrix();
	else if (!strcmp(c, "b20-caller-sensitive-set")) b20_caller_sensitive_set();
	else if (!strcmp(c, "b21-unmarked-refused-only-at-project")) b21_unmarked_refused_only_at_project();
	else if (!strcmp(c, "b22-cwd-chain-extent")) b22_cwd_chain_extent();
	else if (!strcmp(c, "b24-event-kinds")) b24_event_kinds();
	else if (!strcmp(c, "b25-substitution-logged-per-path-and-tgid")) b25_substitution_logged_per_path_and_tgid();
	else if (!strcmp(c, "b27-cwd-ino-distinct")) b27_cwd_ino_distinct();
	else if (!strcmp(c, "b28-cwd-input-validated")) b28_cwd_input_validated();
	else if (!strcmp(c, "b29-escape"))    b29_escape();
	else if (!strcmp(c, "b30-absence"))   b30_absence();
	else if (!strcmp(c, "b31-dedupe-tgid")) b31_dedupe_tgid();
	else if (!strcmp(c, "b37-unmarked-never-gets-remote")) b37_unmarked_never_gets_remote();
	else if (!strcmp(c, "b38-view-is-geometry-invariant")) b38_view_is_geometry_invariant();
	else if (!strcmp(c, "b39-chdir-lives-at-every-geometry")) b39_chdir_lives_at_every_geometry();
	else if (!strcmp(c, "b40-marked-is-untouched")) b40_marked_is_untouched();
	else if (!strcmp(c, "b41-no-unmarked-resolution-names-the-remote")) b41_no_unmarked_resolution_names_the_remote();
	else if (!strcmp(c, "b43-uncovered-is-still-the-hosts")) b43_uncovered_is_still_the_hosts();
	else if (!strcmp(c, "b44-dirent-visible")) b44_dirent_visible();
	else if (!strcmp(c, "b46-floor-scope")) b46_floor_scope();
	else if (!strcmp(c, "b47-floor-is-applied-at-every-reporting-op")) b47_floor_is_applied_at_every_reporting_op();
	else if (!strcmp(c, "b48-probe-falls-not-absent")) b48_probe_falls_not_absent();
	else if (!strcmp(c, "b49-table-child-exists")) b49_table_child_exists();
	else if (!strcmp(c, "frame-vectors")) frame_vectors();
	else if (!strcmp(c, "field-vectors")) field_vectors(argc, argv);
	else { fprintf(stderr, "union-policy-driver: unknown case '%s'\n", c); return 2; }

	if (failures) fprintf(stderr, "%s: %d of %d assertions FAILED\n", c, failures, checks);
	return failures ? 1 : 0;
}

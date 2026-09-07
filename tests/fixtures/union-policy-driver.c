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

static void seams(void)
{
	policy_proc.tgid = fake_tgid;
	policy_proc.starttime = fake_start;
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

/* ── B1: longest prefix wins, at a component boundary ───────────────────── */
static void b1_prefix(void)
{
	pin("host\t/tmp/app");
	pin("project\t/tmp/app/inner");
	anc_build();
	CHECK(tier_of("/tmp/app") == T_HOST, "the pin itself is host");
	CHECK(tier_of("/tmp/app/x") == T_HOST, "a child at a boundary is host");
	CHECK(tier_of("/tmp/apple") == T_FAIL, "/tmp/apple does NOT match the pin /tmp/app");
	CHECK(tier_of("/tmp/app-1/x") == T_FAIL, "a sibling sharing the first bytes does not match");
	CHECK(tier_of("/tmp/app/inner/deep") == T_PROJECT, "the LONGER pin wins over the shorter");
}

/* ── B2: an unpinned path is fail-closed, never remote-first ────────────── */
static void b2_failclosed(void)
{
	CHECK((int)T_FAIL == 0, "T_FAIL is enum index 0 (got %d)", (int)T_FAIL);
	pin("host\t/etc/passwd");
	anc_build();
	CHECK(tier_of("/nowhere/at/all") == T_FAIL, "an unpinned path is T_FAIL");
	CHECK(tier_of("/nowhere/at/all") == (enum tier)0, "and T_FAIL is what tier_of returns for no match");
	/* The mechanism, not just the value: an EMPTY table answers fail for
	 * everything, which is what "fail-closed by construction" means. */
	npins = 0;
	CHECK(tier_of("/") == T_FAIL, "with no pins at all, even / is fail");
}

/* ── B3: the ancestor set is EXACT membership, not a prefix rule ────────── */
static void b3_ancestors(void)
{
	pin("host\t/usr/bin/sh");
	anc_build();
	CHECK(resolve_class("/usr") == T_SYNTH, "a strict ancestor of a pin is synthetic");
	CHECK(resolve_class("/usr/bin") == T_SYNTH, "and so is the next one down");
	CHECK(resolve_class("/") == T_SYNTH, "/ is always in the set");
	CHECK(resolve_class("/usr/bin/sh") == T_HOST, "the pin itself keeps its own tier");
	CHECK(resolve_class("/usrX") == T_FAIL, "/usrX is NOT an ancestor — membership is exact");
	CHECK(resolve_class("/usr/bi") == T_FAIL, "nor is a prefix of a component");
	CHECK(resolve_class("/usr/lib") == T_FAIL, "nor an unrelated sibling");
}

/* An exactly-pinned path is that pin, never a synthetic node: the pin is the
 * more specific statement and anc_build drops it from the set. */
static void b3b_exact_pin_wins(void)
{
	pin("host\t/usr");
	pin("host\t/usr/bin/sh");
	anc_build();
	CHECK(anc_find("/usr") < 0, "an exactly-pinned ancestor is dropped from the set");
	CHECK(resolve_class("/usr") == T_HOST, "and resolves to its pin");
	CHECK(resolve_class("/usr/bin") == T_HOST, "its unpinned child follows the pin, not the set");
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
	policy_synth_children("/", collect, NULL);
	CHECK(listed_has("usr"), "/ lists the synthetic ancestor usr");
	CHECK(listed_has("srv"), "/ lists the synthetic ancestor srv");
	CHECK(listed_has("proc"), "/ lists the bind node proc");
	CHECK(listed_has("run"), "/ lists run — an ancestor of a hide pin is still traversable");
	CHECK(listed_has("var"), "/ lists var — an ancestor of a fail pin is still traversable");
	CHECK(!listed_has("sh") && !listed_has("app"), "/ lists no GRANDchild");
	CHECK(nlisted == 5, "/ lists exactly its five children, got %zu", nlisted);

	nlisted = 0;
	policy_synth_children("/run", collect, NULL);
	CHECK(nlisted == 0, "a hide child is suppressed from its parent's listing, got %zu", nlisted);

	nlisted = 0;
	policy_synth_children("/var", collect, NULL);
	CHECK(nlisted == 0, "a fail child is suppressed too — every op on it answers -ENOENT");

	nlisted = 0;
	policy_synth_children("/usr", collect, NULL);
	CHECK(nlisted == 1 && listed_has("bin"), "/usr lists exactly bin");

	nlisted = 0;
	policy_synth_children("/usr/bin", collect, NULL);
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

	CHECK(policy_synth_getattr("/zzz-no-such-root-on-this-host", &st) == 0,
	      "a synthetic node over a nonexistent host path still answers");
	CHECK((st.st_mode & 07777) == 0555 && S_ISDIR(st.st_mode), "mode is a 0555 directory (got %o)", st.st_mode);
	CHECK(st.st_uid == 0 && st.st_gid == 0, "uid and gid are 0");
	CHECK(st.st_nlink == 2, "nlink is 2");
	CHECK(st.st_size == 0, "size is 0");
	CHECK(st.st_atime == 0 && st.st_mtime == 0 && st.st_ctime == 0, "all three times are 0");
	CHECK(st.st_ino >= SYNTH_INO_BASE, "the inode comes from the ancestor table");

	CHECK(policy_synth_getattr("/usr", &st2) == 0, "and over a host path that DOES exist");
	CHECK(st2.st_mtime == 0 && (st2.st_mode & 07777) == 0555,
	      "it answers the fixed node, not the host's /usr (mode %o mtime %lld)",
	      st2.st_mode, (long long)st2.st_mtime);
	CHECK(st2.st_ino != st.st_ino, "two synthetic nodes get distinct inodes");
	CHECK(policy_synth_getattr("/not/in/the/table", &st2) == -ENOENT,
	      "a path outside the table is not synthetic");

	/* Stable across calls, which is what makes the inode usable at all. */
	{
		struct stat a, b;
		policy_synth_getattr("/usr", &a);
		policy_synth_getattr("/usr", &b);
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
	CHECK(resolve_class("/usr/bin/sh") == T_HOST,
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

	/* THE CRITERION, not just the key: B is unmarked, and the cache is
	 * consulted BEFORE the mark check, so only the tgid in the key stops B
	 * being handed A's warmed resolution. */
	CHECK(policy_project_route("getattr", "/srv/app/f", 2000, CCU_STAT, 0) == -ENOENT,
	      "B is denied despite A's warm entry for the same path");

	/* The raw key, so the mechanism is pinned as well as its consequence. */
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

/* ── B13: the refusal log records each (path, reason) exactly once ───────── */
static void b13_refusals(void)
{
	char tmpl[] = "/tmp/cc-policy-refusalsXXXXXX";
	int fd = mkstemp(tmpl);
	char line[512];
	int n_ax = 0, n_ay = 0, n_bx = 0, total = 0;
	FILE *rd;

	if (fd < 0) { printf("FAIL %s: mkstemp\n", case_name); exit(1); }
	refusal_fp = fdopen(fd, "w+");
	setvbuf(refusal_fp, NULL, _IOLBF, 0);

	policy_refuse("getattr", "/a", "x");
	policy_refuse("getattr", "/a", "x");        /* same op, same pair */
	policy_refuse("open",    "/a", "x");        /* DIFFERENT op, same pair */
	policy_refuse("getattr", "/a", "y");        /* same path, different reason */
	policy_refuse("getattr", "/b", "x");        /* different path, same reason */

	rewind(refusal_fp);
	rd = refusal_fp;
	while (fgets(line, sizeof(line), rd)) {
		total++;
		if (strstr(line, "\t/a\tx\n")) n_ax++;
		if (strstr(line, "\t/a\ty\n")) n_ay++;
		if (strstr(line, "\t/b\tx\n")) n_bx++;
	}
	CHECK(n_ax == 1, "(/a, x) is recorded exactly once across THREE calls, got %d", n_ax);
	CHECK(n_ay == 1, "(/a, y) — a different reason for the same path is its own entry");
	CHECK(n_bx == 1, "(/b, x) — a different path is its own entry");
	CHECK(total == 3, "three distinct pairs, three lines, got %d", total);
	fclose(refusal_fp);
	refusal_fp = NULL;
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
	else if (!strcmp(c, "frame-vectors")) frame_vectors();
	else { fprintf(stderr, "union-policy-driver: unknown case '%s'\n", c); return 2; }

	if (failures) fprintf(stderr, "%s: %d of %d assertions FAILED\n", c, failures, checks);
	return failures ? 1 : 0;
}

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
		if (strstr(line, "\tremote-absent\n"))            n_absent++;
		if (strstr(line, "\tcontrol-refused\n"))          n_refused++;
		if (strstr(line, "\tcontrol-unavailable\n"))      n_unavail++;
		if (strstr(line, "\tunmarked-project-denied\n"))  n_unmarked++;
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

/* ── B13: the event log records each (path, reason) exactly once ────────── */
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

	policy_event(EV_DENY,   "getattr", "/a", "x");
	policy_event(EV_DENY,   "getattr", "/a", "x");      /* same op, same pair */
	policy_event(EV_DENY,   "open",    "/a", "x");      /* DIFFERENT op, same pair */
	policy_event(EV_DENY,   "getattr", "/a", "y");      /* same path, different reason */
	policy_event(EV_DENY,   "getattr", "/b", "x");      /* different path, same reason */
	policy_event(EV_SERVED, "getattr", "/c", "z");      /* the other kind */

	rewind(event_fp);
	rd = event_fp;
	while (fgets(line, sizeof(line), rd)) {
		total++;
		if (strstr(line, "deny\tgetattr\t/a\tx\n"))   n_ax++;
		if (strstr(line, "deny\tgetattr\t/a\ty\n"))   n_ay++;
		if (strstr(line, "deny\tgetattr\t/b\tx\n"))   n_bx++;
		if (strstr(line, "served\tgetattr\t/c\tz\n")) n_cz++;
	}
	CHECK(n_ax == 1, "(/a, x) is recorded exactly once across THREE calls, got %d", n_ax);
	CHECK(n_ay == 1, "(/a, y) — a different reason for the same path is its own entry");
	CHECK(n_bx == 1, "(/b, x) — a different path is its own entry");
	CHECK(n_cz == 1, "an EV_SERVED row is written with kind `served` (%d)", n_cz);
	CHECK(total == 4, "four distinct pairs, four lines, got %d", total);
	/* THE KIND IS THE FIRST COLUMN AND THE ROW IS FOUR COLUMNS. Asserted on the
	 * shape rather than only through the strstr needles above, which a row that
	 * appended the kind LAST would also satisfy. */
	rewind(event_fp);
	while (fgets(line, sizeof(line), rd)) {
		int tabs = 0;
		char *t;
		for (t = line; *t; t++) if (*t == '\t') tabs++;
		CHECK(tabs == 3, "the row has exactly three tabs — kind, op, path, reason (%d): %s",
		      tabs, line);
		CHECK(strncmp(line, "deny\t", 5) == 0 || strncmp(line, "served\t", 7) == 0,
		      "the FIRST column is the kind: %s", line);
	}
	/* WHAT THIS CASE DELIBERATELY DOES NOT PIN, so nobody credits it with the
	 * kind's place in the dedupe key. The key is (path, reason) and NOT
	 * (kind, path, reason), and that choice is UNOBSERVABLE: every reason maps
	 * to exactly one kind — derived from both C sources and set-compared in
	 * both directions by tests/fuse-union-policy.test.mjs — so the two keys
	 * partition every emission this daemon can produce identically, and no
	 * mutant can distinguish them. An assertion here would either duplicate
	 * the (/a, x) count above or manufacture a cross-kind emission the daemon
	 * cannot make. See policy_event's own comment for what that costs. */
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
		/* AND `cwd` IS REJECTED THE SAME WAY. This is the STRUCTURAL
		 * proof that the cwd-chain exemption can never enter the
		 * artifact the hook's tier table shares: T_CWD is derived in C
		 * by route(), so no pins file can name it and no `cwd` entry can
		 * reach `renderPinsFile`'s consumers. */
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
 * tier in, errno out, no libfuse — and it was reachable only from a regex over
 * union.c and from real-gate R7, which a mutation prover cannot run. Both of
 * its directions are asserted here, so `return -EOPNOTSUPP` -> `return 0` and a
 * flipped tier test die in the deterministic suite.
 */
/* ── B16: abandon_claim ─────────────────────────────────────────────────── */
/*
 * THE GUARD AGAINST THE WORST FAILURE MODE IN THIS TICKET, and until now it had
 * no behavioural coverage anywhere: the prover measured that both its mutants
 * were killed ONLY by A16's sha256 latch, which fires for any C edit and so
 * says nothing about behaviour.
 *
 * What it owes: a project-tier abandon SENDS A FRAME — a DIRTY carrying
 * CCU_FLAG_RELEASE_ONLY, because the op failed before mutating and the mirror
 * still holds cc's own unmodified cache copy, so there is nothing to reconcile
 * — and invalidates the cached routing decision. At any other tier it sends
 * nothing, because no other tier ever took a claim.
 *
 * IT PINNED A BARE ZERO UNTIL CARD 2026-0356's REFINE ROUND, and the byte below
 * is the whole of what changed: a flagless frame is indistinguishable from
 * `pt_release`'s frame for a handle that WROTE and never flushed. The reasoning
 * is at the assertion.
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
	 * opposite of the whole point. AND A BARE ZERO — which this case pinned
	 * until card 2026-0356 — is indistinguishable on the wire from the
	 * releasing frame of a handle that WROTE and never flushed, so cc read an
	 * abandon as a reconcile: it pushed the mirror's unmodified cache copy
	 * and, if that push failed, recorded a `diverged` fault and froze its
	 * cache for the session on a file the worker never wrote.
	 *
	 * RELEASE_ONLY says what an abandon means and nothing else — release the
	 * claim, carry nothing — so no push is attempted and no fault can arise.
	 * It also drops a whole-file upload from every error path, which
	 * `policy_abandon_claim`'s own block in policy.h had already named as a
	 * cost, and with it the hazard of overwriting the box's newer bytes with
	 * cc's stale cache copy. */
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
/*
 * THIS LAYER IS MANDATORY AND THE REAL GATE CANNOT SUBSTITUTE FOR IT.
 * `MOUNT_OPTS` carries `default_permissions`, so through a real mount the
 * KERNEL refuses an unmarked `opendir` against the 0111 node before the daemon
 * is ever asked — the daemon's own op allow-list, the gate that actually
 * enforces the conjunction, is MASKED by a lower layer. A masked guard is
 * unkillable by mutation: break it and every real-mount test still passes. Only
 * this fixture can prove it.
 *
 * `argv[2..]` are op names, handed over by the .mjs so the allow-list is driven
 * from the SAME literal the source-shape test checks against union.c's op
 * strings. Running the case with no ops still asserts the two named below.
 */
static void b17_cwd_exempt(int argc, char **argv)
{
	char tmpl[] = "/tmp/cc-policy-cwdXXXXXX";
	int fd = mkstemp(tmpl);
	char line[512];
	struct stat st;
	int n_sub = 0, n_file = 0, n_root = 0, i;
	int calls;

	if (fd < 0) { printf("FAIL %s: mkstemp\n", case_name); exit(1); }
	event_fp = fdopen(fd, "w+");
	setvbuf(event_fp, NULL, _IOLBF, 0);

	pin("project\t/srv/app");              /* pins[0] */
	pin("host\t/etc");                     /* pins[1] */
	/* A PROJECT PIN AT A PATH THAT DOES NOT EXIST ON THIS HOST (C7): if the
	 * node were ever filled from a host stat it would answer -ENOENT here. */
	pin("project\t/zzz-no-such-root-on-this-host/app");   /* pins[2] */
	anc_build();
	/* THE CWD, AS A SEAM. It lives in policy.h precisely so this fixture can
	 * assign it; union.c reads it from CC_UNION_CWD and refuses to mount
	 * without it. Here the cwd IS the project root, which is the default
	 * configuration and what makes b17 the root-only case that b22 widens. */
	cwd_path = "/srv/app";
	proc_set(500, 500, 111);               /* an unmarked thread group */
	proc_set(600, 600, 222);               /* the one we mark */
	policy_mark_tid(600);

	/* ── C1: the root resolves, and only for an unmarked caller ─────── */
	CHECK(policy_cwd_exempt("getattr", "/srv/app", 500) == 1,
	      "an UNMARKED caller may getattr the exact project root");
	CHECK(xport_calls == 0, "and the exemption sent no control frame");

	/* ── C2: a marked caller is NOT exempted ────────────────────────── */
	CHECK(policy_cwd_exempt("getattr", "/srv/app", 600) == 0,
	      "a MARKED caller is not exempted — it gets the real routed answer");
	CHECK(policy_project_route("getattr", "/srv/app", 600, CCU_STAT, 0) == 0,
	      "and that answer is the routed one");
	CHECK(xport_calls == 1, "which took exactly one control round trip (%d)", xport_calls);
	calls = xport_calls;                   /* every unmarked op below adds none */

	/* ── C3: nothing inside it, both directions of the ruling ───────── */
	CHECK(policy_cwd_exempt("getattr", "/srv/app/README.md", 500) == 0,
	      "a FILE in the project tree is not exempt");
	CHECK(policy_project_route("getattr", "/srv/app/README.md", 500, CCU_STAT, 0) == -ENOENT,
	      "and it is denied");
	CHECK(policy_cwd_exempt("getattr", "/srv/app/src", 500) == 0,
	      "a project-tier DIRECTORY that is not the root is not exempt either");
	CHECK(policy_project_route("getattr", "/srv/app/src", 500, CCU_STAT, 0) == -ENOENT,
	      "and it is denied");
	CHECK(xport_calls == calls, "no control frame was sent on the unmarked caller's behalf");

	/* ── C4: the op allow-list is `getattr` alone ───────────────────── */
	CHECK(policy_cwd_exempt("opendir", "/srv/app", 500) == 0,
	      "opendir is NOT exempt — a directory's listing is content inside it");
	CHECK(policy_cwd_exempt("access", "/srv/app", 500) == 0,
	      "neither is access — default_permissions means the kernel answers it");
	for (i = 2; i < argc; i++)
		CHECK(policy_cwd_exempt(argv[i], "/srv/app", 500) == 0,
		      "`%s` is not exempt", argv[i]);

	/* ── C6: the node's attributes, against literals ────────────────── */
	CHECK(policy_cwd_getattr("/srv/app", &st) == 0, "the cwd node answers");
	CHECK((st.st_mode & 07777) == 0111 && S_ISDIR(st.st_mode),
	      "mode is a 0111 directory — enter, do not read (got %o)", st.st_mode);
	CHECK(st.st_nlink == 2, "nlink is 2");
	CHECK(st.st_uid == 0 && st.st_gid == 0, "uid and gid are 0");
	CHECK(st.st_size == 0, "size is 0");
	CHECK(st.st_atime == 0 && st.st_mtime == 0 && st.st_ctime == 0, "all three times are 0");
	/* THE INODE IS THE CHAIN'S OWN SUB-RANGE, not policy_bind_ino's. Written
	 * as the arithmetic rather than as a number so the three sub-ranges' bases
	 * stay visible; b27 pins the disjointness. `/srv/app` is at depth 2. */
	CHECK(st.st_ino == SYNTH_INO_BASE + MAX_ANC + npins + 2,
	      "the inode is in the cwd chain's sub-range, at the component's depth");
	CHECK(st.st_ino != policy_bind_ino("/srv/app"),
	      "and NOT the exact-pin inode — the two ranges are distinct");
	CHECK(policy_cwd_getattr("/etc", &st) == -ENOENT,
	      "a path off the cwd chain gets no cwd node, host pin or not");
	CHECK(policy_cwd_exempt("getattr", "/etc", 500) == 0,
	      "and an unmarked caller is not exempted at one");

	/* ── C7: it touches no filesystem and asks nobody ───────────────── */
	/* THE CWD MOVES for this check alone: the point is that the node answers
	 * for a path that DOES NOT EXIST ON THIS HOST, so the cwd has to be that
	 * path. Restored below, because the cache arithmetic that follows is about
	 * `/srv/app`. */
	cwd_path = "/zzz-no-such-root-on-this-host/app";
	CHECK(policy_cwd_getattr("/zzz-no-such-root-on-this-host/app", &st) == 0,
	      "a cwd over a nonexistent host path still answers");
	CHECK((st.st_mode & 07777) == 0111 && S_ISDIR(st.st_mode),
	      "with the same fixed mode (got %o)", st.st_mode);
	CHECK(st.st_nlink == 2 && st.st_uid == 0 && st.st_gid == 0 && st.st_size == 0,
	      "and the same fixed nlink, ownership and size");
	CHECK(st.st_atime == 0 && st.st_mtime == 0 && st.st_ctime == 0, "and the same zero times");
	CHECK(st.st_ino == SYNTH_INO_BASE + MAX_ANC + npins + 2,
	      "and its own depth's inode in the chain sub-range");
	CHECK(policy_cwd_exempt("getattr", "/zzz-no-such-root-on-this-host/app", 500) == 1,
	      "and it is exempt without the path existing");
	CHECK(policy_cwd_getattr("/nowhere/at/all", &st) == -ENOENT,
	      "a path off the chain gets no cwd node either");
	CHECK(policy_cwd_exempt("getattr", "/nowhere/at/all", 500) == 0,
	      "and an unmarked caller is not exempted at one");
	cwd_path = "/srv/app";
	CHECK(xport_calls == calls,
	      "NO CONTROL FRAME for any unmarked op (%d)", xport_calls);

	/* AND NO CACHE ENTRY, ASSERTED RATHER THAN ASSUMED. `cache_put` is pure
	 * in-process memory and never touches the transport, so `xport_calls`
	 * alone cannot see one — an exemption implemented by routing through
	 * ccu_call/cache_put would satisfy every check above.
	 *
	 * THE CACHE'S OWN KEY IS THE INSTRUMENT: it is (tgid, path), and
	 * `policy_project_route` consults it for any op but FETCH. So an entry
	 * written by an UNMARKED exempted getattr would be found by that SAME
	 * thread group once marked, and would serve it with no round trip. One
	 * tgid, one path, across the mark transition: FLAT means an entry
	 * existed, +1 means none did. It is also why an unmarked denial is never
	 * written back — a mark arriving later must be visible on the very next
	 * op rather than one TTL after it. */
	/* WHAT THIS CASE DOES NOT COVER, SO NOBODY LATER CREDITS IT WITH BOTH
	 * HALVES. The plan's C7 mutant — "implement the exemption by routing
	 * getattr through ccu_call/cache_put" — has two sides. The policy.h side
	 * (this predicate or policy_cwd_getattr sending a frame or writing an
	 * entry) is what the arithmetic below kills. The union.c side — pt_getattr
	 * answering an exempted getattr from the MIRROR instead of calling
	 * policy_cwd_getattr — is INVISIBLE HERE BY CONSTRUCTION: this fixture
	 * drives the predicate and policy_cwd_getattr directly and never reaches
	 * an op body, so the frame and entry counts come out identical either way.
	 * That half rests on R8(d)'s '111 0 0' literal, which a mirror-routed
	 * answer cannot satisfy — the mirror entry carries the source's real mode
	 * and ownership, not this node's fixed ones. */
	proc_set(700, 700, 333);
	CHECK(policy_cwd_exempt("getattr", "/srv/app", 700) == 1,
	      "a second unmarked thread group is exempted too");
	policy_mark_tid(700);
	CHECK(policy_project_route("getattr", "/srv/app", 700, CCU_STAT, 0) == 0,
	      "and once MARKED it gets the routed answer");
	CHECK(xport_calls == calls + 1,
	      "which cost a control round trip — so the exemption wrote NO CACHE ENTRY "
	      "the mark could then be served from (%d, expected %d)", xport_calls, calls + 1);
	calls = xport_calls;
	/* THE POSITIVE CONTROL, and without it the assertion above is a claim
	 * about a mechanism that might not exist: an entry at (700, "/srv/app")
	 * really does suppress the round trip. So the +1 is evidence there was
	 * no entry, rather than evidence the cache never serves anything. */
	CHECK(policy_project_route("getattr", "/srv/app", 700, CCU_STAT, 0) == 0,
	      "the SAME marked route again is answered");
	CHECK(xport_calls == calls,
	      "from the cache, with no second round trip — which is what an entry "
	      "written by the exemption would have done to the call above (%d)", xport_calls);

	/* THE EVENT LOG: the two paths under the root are refused BY NAME, and
	 * the root itself is not refused at all. */
	rewind(event_fp);
	while (fgets(line, sizeof(line), event_fp)) {
		if (strstr(line, "\tunmarked-project-denied\n") == NULL) continue;
		if (strstr(line, "\t/srv/app/src\t"))       n_sub++;
		if (strstr(line, "\t/srv/app/README.md\t")) n_file++;
		if (strstr(line, "\t/srv/app\t"))           n_root++;
	}
	CHECK(n_file == 1, "the file's denial is logged unmarked-project-denied (%d)", n_file);
	CHECK(n_sub == 1, "so is the subdirectory's (%d)", n_sub);
	CHECK(n_root == 0, "and the project ROOT is refused to nobody (%d)", n_root);
	fclose(event_fp);
	event_fp = NULL;
	unlink(tmpl);
}

/* ── B18: the wide advertised mirror root IS repaired by the widening ────── */
/*
 * THE PRIMARY PROOF OF THE CWD-CHAIN WIDENING, and it lives at the policy layer
 * because a mount test cannot see it: `default_permissions` makes the KERNEL
 * refuse the unmarked `opendir` against the 0111 node before the daemon's own
 * op allow-list is ever asked.
 *
 * INVERTED FROM WHAT IT ASSERTED BEFORE, and the inversion IS the evidence card
 * 2026-0375 is closed. When a provider advertises `mirrorRoot: '/'`,
 * `buildTierTable` emits TWO project pins, so an intermediate directory such as
 * `/srv` matches the `/` pin by longest prefix: project tier with NO EXACT PIN.
 * Under the old `pin_exact` test that made it not exempt, and a chdir to
 * `/srv/app` died one component early at `/srv`. The 2026-09-08 owner amendment
 * exempts every directory component of the cwd, so that chdir must now succeed
 * — and this case asserts the exemption at `/srv` where it used to assert the
 * denial.
 *
 * The residual was created by 2026-0373's narrowness and removed by a ruling,
 * not by a defect fix. 2026-0382 absorbs 2026-0375.
 */
static void b18_cwd_wide_mirror(void)
{
	pin("project\t/");
	pin("project\t/srv/app");
	anc_build();
	cwd_path = "/srv/app";
	proc_set(500, 500, 111);

	CHECK(tier_of("/srv") == T_PROJECT, "an intermediate dir is project tier by longest prefix");
	CHECK(pin_exact("/srv") == NULL, "with no exact pin of its own");
	/* THE INVERSION. `pin_exact` said no; the chain predicate says yes. */
	CHECK(policy_cwd_exempt("getattr", "/srv", 500) == 1,
	      "so it IS exempt as a cwd chain component, and the chdir through it lives");
	CHECK(policy_cwd_exempt("getattr", "/", 500) == 1, "so is the root: /");
	CHECK(policy_cwd_exempt("getattr", "/srv/app", 500) == 1, "and the cwd itself");
	/* AND NO FURTHER. A sibling of the intermediate component, a child of the
	 * cwd and an unrelated project-tier path all stay denied — the widening is
	 * to the chain, not to the tier. */
	CHECK(policy_cwd_exempt("getattr", "/srvX", 500) == 0, "a sibling of /srv is not");
	CHECK(policy_cwd_exempt("getattr", "/srv/other", 500) == 0, "nor a sibling of the cwd");
	CHECK(policy_cwd_exempt("getattr", "/srv/app/sub", 500) == 0, "nor a child of the cwd");
	CHECK(policy_cwd_exempt("getattr", "/etc", 500) == 0, "nor an unrelated project-tier dir");
}

/* ── B19: the caller-tier matrix, all seven tiers × {marked, unmarked} ───── */
/*
 * THE RULING IN ONE TRUTH TABLE. Identity everywhere EXCEPT (unmarked, T_FAIL),
 * which becomes T_HOST.
 *
 * THE LOOP BOUND CANNOT SILENTLY UNDER-COVER. `tier_name` (policy.h) switches
 * over `enum tier` with no `default:` arm, so an eighth member fails the
 * `-Wall -Werror` compile of this very fixture before any assertion runs. The
 * member NAMES are pinned in tests/fuse-union-policy.test.mjs against the enum
 * declaration itself.
 */
static void b19_caller_tier_matrix(void)
{
	int t;
	int seen_fail_sub = 0, seen_identity = 0;

	for (t = 0; t <= (int)T_CWD; t++) {
		enum tier ti = (enum tier)t;
		enum tier marked   = policy_caller_tier("getattr", "/p", ti, 1);
		enum tier unmarked = policy_caller_tier("getattr", "/p", ti, 0);

		/* THE MARKED SIDE IS IDENTITY AT EVERY TIER. A substitution that
		 * fired for the CLI too would serve it the host at `fail`, which
		 * is the "one path, two answers" the epic removed. */
		CHECK(marked == ti, "marked: %s is unchanged (got %s)",
		      tier_name(ti), tier_name(marked));
		if (ti == T_FAIL) {
			CHECK(unmarked == T_HOST,
			      "unmarked: fail → host (got %s)", tier_name(unmarked));
			seen_fail_sub = 1;
		} else {
			/* project, hide, bind, synth, host, cwd — EVERY ONE
			 * unchanged, and each for its own reason: project is the
			 * owner's ruling, hide is what keeps the mirror and the
			 * control socket unreachable, bind is resolved by unmarked
			 * `mount` before the mark fires. */
			CHECK(unmarked == ti, "unmarked: %s is unchanged (got %s)",
			      tier_name(ti), tier_name(unmarked));
			seen_identity++;
		}
	}
	/* NON-VACUITY: the loop really drove seven tiers and really saw the one
	 * substitution, so an empty or short loop cannot read as a pass. */
	CHECK(seen_fail_sub == 1, "the T_FAIL row was driven");
	CHECK(seen_identity == 6, "and the other six were too (%d)", seen_identity);
}

/* ── B20: the caller-sensitive set is EXACTLY {T_FAIL} ──────────────────── */
/*
 * SEPARATE FROM B19 BECAUSE THE PREDICATE IS SEPARATE, and route() consults it
 * BEFORE the map: a tier wrongly in this set pays two /proc reads per op and
 * hands `policy_caller_tier` a tier it was not asked about, while a tier
 * wrongly out of it can never be substituted no matter what the map says.
 */
static void b20_caller_sensitive_set(void)
{
	int t;
	int n_sensitive = 0;

	for (t = 0; t <= (int)T_CWD; t++) {
		enum tier ti = (enum tier)t;
		int want = (ti == T_FAIL);
		CHECK(policy_tier_is_caller_sensitive(ti) == want,
		      "%s is %scaller-sensitive", tier_name(ti), want ? "" : "NOT ");
		if (policy_tier_is_caller_sensitive(ti))
			n_sensitive++;
	}
	CHECK(n_sensitive == 1, "exactly one tier is caller-sensitive (%d)", n_sensitive);
}

/* ── B21: for an unmarked caller, only the PROJECT tier denies ──────────── */
/*
 * THE OTHER HALF OF THE RULING, READ OFF THE LOG RATHER THAN OFF A RETURN
 * VALUE. Card 2026-0382's title said "never consults the tier table at all";
 * the owner narrowed it to one tier, and this is the narrowing asserted from
 * the side a maintainer sees: driving every tier through the substitution
 * writes NO `deny` row at all, and the only denial an unmarked caller can take
 * inside policy.h is `policy_project_route`'s mark check.
 */
static void b21_unmarked_refused_only_at_project(void)
{
	char tmpl[] = "/tmp/cc-policy-b21XXXXXX";
	int fd = mkstemp(tmpl);
	char line[512];
	int t, n_deny = 0, n_served = 0, n_project_deny = 0;

	if (fd < 0) { printf("FAIL %s: mkstemp\n", case_name); exit(1); }
	event_fp = fdopen(fd, "w+");
	setvbuf(event_fp, NULL, _IOLBF, 0);

	pin("project\t/srv/app");
	anc_build();
	cwd_path = "/srv/app";
	proc_set(500, 500, 111);               /* unmarked, and stays unmarked */

	/* EVERY TIER, one distinct path each so the dedupe cannot collapse rows
	 * and hide one. */
	for (t = 0; t <= (int)T_CWD; t++) {
		char path[64];
		snprintf(path, sizeof(path), "/probe-%d", t);
		(void)policy_caller_tier("getattr", path, (enum tier)t, 0);
	}
	rewind(event_fp);
	while (fgets(line, sizeof(line), event_fp)) {
		if (strncmp(line, "deny\t", 5) == 0)     n_deny++;
		if (strncmp(line, "served\t", 7) == 0)   n_served++;
	}
	CHECK(n_deny == 0, "the substitution denies at NO tier (%d deny rows)", n_deny);
	CHECK(n_served == 1, "and it serves at exactly one — T_FAIL (%d served rows)", n_served);

	/* AND THE ONE DENIAL THERE IS. Non-vacuity for the zero above: an
	 * unmarked caller CAN be denied, at the project tier, and the sink this
	 * case reads really does record. */
	CHECK(policy_project_route("getattr", "/srv/app/f", 500, CCU_STAT, 0) == -ENOENT,
	      "an unmarked caller at a project path is still denied");
	rewind(event_fp);
	while (fgets(line, sizeof(line), event_fp))
		if (strstr(line, "deny\tgetattr\t/srv/app/f\tunmarked-project-denied\n"))
			n_project_deny++;
	CHECK(n_project_deny == 1, "and the denial is logged deny/unmarked-project-denied (%d)",
	      n_project_deny);
	fclose(event_fp);
	event_fp = NULL;
	unlink(tmpl);
}

/* ── B22: the cwd chain's EXTENT, and both directions of the sibling trap ── */
/*
 * THE FIXTURE IS A PREFIX-SHARING SIBLING, IN BOTH DIRECTIONS, AND THAT IS THE
 * WHOLE POINT OF THE CASE. A case built from unrelated paths passes under the
 * naive `strncmp` this guard exists to reject and proves nothing.
 *
 * The two directions are rejected by DIFFERENT MECHANICS, so a case exercising
 * one proves half the guard:
 *   cwd /root/app3, path /root/app   → rejected by the BOUNDARY test
 *                                      (`cwd_path[9] == '3'`)
 *   cwd /root/app,  path /root/app3  → rejected by `strncmp` itself, which
 *                                      meets cwd's '\0' against '3'
 */
static void b22_cwd_chain_extent(void)
{
	pin("project\t/");
	pin("project\t/root/app3");
	anc_build();
	proc_set(500, 500, 111);               /* unmarked */
	proc_set(600, 600, 222);
	policy_mark_tid(600);

	cwd_path = "/root/app3";
	/* ── ON the chain ──────────────────────────────────────────────── */
	CHECK(policy_cwd_component("/") == 1, "/ is on the chain");
	CHECK(policy_cwd_component("/root") == 1, "and the intermediate component");
	CHECK(policy_cwd_component("/root/app3") == 1, "and the cwd itself");
	/* ── OFF it — the sibling trap, direction one ───────────────────── */
	CHECK(policy_cwd_component("/root/app") == 0,
	      "/root/app is a SIBLING sharing a prefix — the boundary check is the "
	      "only thing rejecting it");
	CHECK(policy_cwd_component("/root/ap") == 0, "and so is /root/ap");
	CHECK(policy_cwd_component("/roo") == 0, "and /roo, a prefix of a component");
	CHECK(policy_cwd_component("/root/app3x") == 0, "and /root/app3x");
	CHECK(policy_cwd_component("/root/app3/sub") == 0,
	      "a CHILD of the cwd is not a component — the chain is upward only");
	CHECK(policy_cwd_component("/root/other") == 0, "nor an unrelated sibling");
	CHECK(policy_cwd_component("relative/app3") == 0, "nor a relative path");

	/* ── the sibling trap, DIRECTION TWO: the same pair reversed ────── */
	cwd_path = "/root/app";
	CHECK(policy_cwd_component("/root/app3") == 0,
	      "with cwd /root/app the LONGER sibling /root/app3 is off the chain — "
	      "rejected by strncmp, not by the boundary test");
	CHECK(policy_cwd_component("/root/app") == 1, "while the cwd itself is on it");
	CHECK(policy_cwd_component("/root") == 1, "and its parent");

	/* ── the whole conjunction, through policy_cwd_exempt ───────────── */
	cwd_path = "/root/app3";
	CHECK(policy_cwd_exempt("getattr", "/root", 500) == 1,
	      "an unmarked caller may getattr an intermediate component");
	CHECK(policy_cwd_exempt("getattr", "/root/app", 500) == 0,
	      "and not its prefix-sharing sibling");
	CHECK(policy_cwd_exempt("readdir", "/root", 500) == 0,
	      "the op allow-list still holds on a chain component");
	CHECK(policy_cwd_exempt("getattr", "/root", 600) == 0,
	      "and a MARKED caller is still not exempted anywhere on the chain");

	/* ── NO CWD AT ALL IS FAIL-CLOSED, and union.c refuses to mount on
	 *    it precisely because this is what it would mean: the project root
	 *    itself un-exempted, and card 2026-0373 regressed. ───────────── */
	cwd_path = NULL;
	CHECK(policy_cwd_component("/") == 0, "with no cwd injected, / is not a component");
	CHECK(policy_cwd_component("/root/app3") == 0, "nor is the project root");
	CHECK(policy_cwd_exempt("getattr", "/root/app3", 500) == 0,
	      "so nothing is exempt and every unmarked chdir dies");
}

/* ── B24: every reason maps to exactly ONE kind, at the policy.h sites ──── */
/*
 * THE KIND IS PINNED WHERE IT IS PRODUCED — read back out of the sink, never
 * asserted against a second transcription of the classification.
 *
 * THIS CASE COVERS THE FOUR REASONS policy.h EMITS plus the new substitution.
 * The other seven live in union.c op bodies no deterministic fixture can reach;
 * their kinds are pinned by a SOURCE-DERIVED two-directional set equality in
 * tests/fuse-union-policy.test.mjs, which reads every `policy_event(` call site
 * in both C sources. Split deliberately, and stated so neither half is credited
 * with the other's coverage.
 */
static void b24_event_kinds(void)
{
	char tmpl[] = "/tmp/cc-policy-b24XXXXXX";
	int fd = mkstemp(tmpl);
	char line[512];
	int i, rows = 0;
	static const struct { const char *reason; const char *kind; } want[] = {
		{ "unmarked-project-denied", "deny"   },
		{ "control-unavailable",     "deny"   },
		{ "remote-absent",           "deny"   },
		{ "control-refused",         "deny"   },
		{ "unmarked-host-served",    "served" },
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
	(void)policy_caller_tier("getattr", "/unpinned/thing", T_FAIL, 0);

	rewind(event_fp);
	while (fgets(line, sizeof(line), event_fp)) {
		rows++;
		for (i = 0; i < (int)(sizeof(want) / sizeof(want[0])); i++) {
			char needle[128];
			snprintf(needle, sizeof(needle), "\t%s\n", want[i].reason);
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
	/* SET EQUALITY, THE OTHER DIRECTION: five emissions, five rows and no
	 * sixth — so a reason this table does not name cannot slip through
	 * unclassified. */
	CHECK(rows == (int)(sizeof(want) / sizeof(want[0])),
	      "five reasons, five rows, nothing unclassified (%d)", rows);
	fclose(event_fp);
	event_fp = NULL;
	unlink(tmpl);
}

/* ── B25: the substitution is logged at `fail`, and ONLY at `fail` ──────── */
/*
 * THE SUBSTITUTION'S COST, PAID. After `fail → host` an unmarked caller's
 * missing object writes no `deny` row at all — the host's ENOENT is not a
 * policy event, and route() could not know about it anyway. So the row fires on
 * the SUBSTITUTION itself, whatever the subsequent host read does, and it means
 * "an unmarked caller was routed to the host at an unpinned path" — which is
 * precisely the fact the pin list is derived from.
 *
 * AND IT IS `served`, NOT `deny`: the op was not refused. A `deny` here would
 * put an every-shell-startup path into R4's fatal filter.
 */
static void b25_substitution_logged_at_fail_only(void)
{
	char tmpl[] = "/tmp/cc-policy-b25XXXXXX";
	int fd = mkstemp(tmpl);
	char line[512];
	int n_served_a = 0, n_served_b = 0, n_any_project = 0, n_deny_project = 0, rows = 0;

	if (fd < 0) { printf("FAIL %s: mkstemp\n", case_name); exit(1); }
	event_fp = fdopen(fd, "w+");
	setvbuf(event_fp, NULL, _IOLBF, 0);

	pin("project\t/srv/app");
	anc_build();
	cwd_path = "/srv/app";
	proc_set(500, 500, 111);               /* unmarked */

	/* TWICE at one path, once at another: the row is per DISTINCT path, which
	 * is what bounds the volume to roughly twenty per shell startup rather
	 * than to the op count. */
	(void)policy_caller_tier("getattr", "/lib/x86_64-linux-gnu/libtinfo.so.6", T_FAIL, 0);
	(void)policy_caller_tier("open",    "/lib/x86_64-linux-gnu/libtinfo.so.6", T_FAIL, 0);
	(void)policy_caller_tier("getattr", "/var/other", T_FAIL, 0);
	/* AND AT THE PROJECT TIER, which must produce a DENIAL and no `served`
	 * row — the ruling read from the log's side. */
	CHECK(policy_project_route("getattr", "/srv/app/f", 500, CCU_STAT, 0) == -ENOENT,
	      "the project tier still denies an unmarked caller");

	rewind(event_fp);
	while (fgets(line, sizeof(line), event_fp)) {
		rows++;
		if (strstr(line, "served\tgetattr\t/lib/x86_64-linux-gnu/libtinfo.so.6\tunmarked-host-served\n"))
			n_served_a++;
		if (strstr(line, "served\tgetattr\t/var/other\tunmarked-host-served\n"))
			n_served_b++;
		if (strstr(line, "\t/srv/app/f\t")) {
			n_any_project++;
			if (strncmp(line, "deny\t", 5) == 0) n_deny_project++;
		}
	}
	CHECK(n_served_a == 1, "one served row per distinct path, across two ops (%d)", n_served_a);
	CHECK(n_served_b == 1, "and the second distinct path has its own (%d)", n_served_b);
	CHECK(n_any_project == 1, "the project path produced exactly one row (%d)", n_any_project);
	CHECK(n_deny_project == 1, "and it is a DENY row, never a served one (%d)", n_deny_project);
	CHECK(rows == 3, "three rows in total, so nothing extra was emitted (%d)", rows);
	fclose(event_fp);
	event_fp = NULL;
	unlink(tmpl);
}

/* ── B26: the cwd node is traverse-only, at EVERY chain component ────────── */
/*
 * THE MODE WHERE IT IS PRODUCED, and the op allow-list where nothing can mask
 * it. Through a real mount `default_permissions` + `0111` makes the KERNEL
 * refuse an unmarked `opendir` before the daemon is asked, so the daemon's own
 * allow-list — the unconditional gate, and the only one for a caller with
 * CAP_DAC_READ_SEARCH — is invisible there. A masked guard is
 * mutation-unkillable: this fixture is the only layer that can prove it.
 *
 * `argv[2..]` are op names, handed over by the .mjs from the SAME literal the
 * source-shape test set-compares against union.c's own routed ops — so an op
 * added there without being classified fails rather than silently joining the
 * allow-list.
 */
static void b26_cwd_traverse_only(int argc, char **argv)
{
	static const char *chain[] = { "/", "/root", "/root/app3" };
	char tmpl[] = "/tmp/cc-policy-b26XXXXXX";
	int fd = mkstemp(tmpl);
	char line[512];
	struct stat st;
	size_t c;
	int i, n_readdir = 0, n_opendir = 0;

	if (fd < 0) { printf("FAIL %s: mkstemp\n", case_name); exit(1); }
	event_fp = fdopen(fd, "w+");
	setvbuf(event_fp, NULL, _IOLBF, 0);

	/* A WIDE ADVERTISED ROOT, so every chain component really is project tier
	 * and `policy_project_route` is the function that would answer it. */
	pin("project\t/");
	pin("project\t/root/app3");
	anc_build();
	cwd_path = "/root/app3";
	proc_set(500, 500, 111);               /* unmarked */

	for (c = 0; c < sizeof(chain) / sizeof(chain[0]); c++) {
		const char *p = chain[c];

		CHECK(policy_cwd_getattr(p, &st) == 0, "%s answers", p);
		CHECK(S_ISDIR(st.st_mode),
		      "%s is a DIRECTORY — the kernel refuses chdir on anything else "
		      "with ENOTDIR before the mode is read at all", p);
		CHECK((st.st_mode & 07777) == 0111,
		      "%s is 0111, enter-and-not-read (got %o)", p, st.st_mode & 07777);
		CHECK(st.st_nlink == 2,
		      "%s reports nlink 2 — the minimum for any directory, so the "
		      "number of remote SUBDIRECTORIES is not disclosed", p);
		CHECK(st.st_uid == 0 && st.st_gid == 0,
		      "%s is root:root, so no owner bit widens it for any uid", p);
		CHECK(st.st_size == 0, "%s reports size 0", p);
		CHECK(st.st_atime == 0 && st.st_mtime == 0 && st.st_ctime == 0,
		      "%s reports all three times as 0", p);

		/* THE OP ALLOW-LIST, ON A CHAIN COMPONENT AND NOT ONLY THE ROOT. */
		CHECK(policy_cwd_exempt("getattr", p, 500) == 1, "%s: getattr is exempt", p);
		CHECK(policy_cwd_exempt("readdir", p, 500) == 0,
		      "%s: readdir is NOT — a listing is the content of the directory", p);
		CHECK(policy_cwd_exempt("opendir", p, 500) == 0,
		      "%s: neither is opendir", p);
		for (i = 2; i < argc; i++)
			CHECK(policy_cwd_exempt(argv[i], p, 500) == 0,
			      "%s: `%s` is not exempt", p, argv[i]);
	}

	/* AND WHAT HAPPENS TO THE REFUSED OPS: route()'s T_PROJECT arm falls
	 * through to policy_project_route, which denies and names it. */
	CHECK(policy_project_route("readdir", "/root", 500, CCU_STAT, 0) == -ENOENT,
	      "a readdir of a chain component is denied");
	CHECK(policy_project_route("opendir", "/root/app3", 500, CCU_STAT, 0) == -ENOENT,
	      "and so is an opendir of the cwd");
	rewind(event_fp);
	while (fgets(line, sizeof(line), event_fp)) {
		if (strstr(line, "deny\treaddir\t/root\tunmarked-project-denied\n"))       n_readdir++;
		if (strstr(line, "deny\topendir\t/root/app3\tunmarked-project-denied\n"))  n_opendir++;
	}
	CHECK(n_readdir == 1, "the refused readdir is logged unmarked-project-denied (%d)", n_readdir);
	CHECK(n_opendir == 1, "and so is the refused opendir (%d)", n_opendir);
	fclose(event_fp);
	event_fp = NULL;
	unlink(tmpl);
}

/* ── B27: every chain component gets a DISTINCT inode, in its own range ─── */
/*
 * WHY THIS MATTERS, and the justification is something that FIRES rather than
 * the `getcwd` story §3b measured as false:
 *
 *   1. `use_ino = 1` is the daemon's own stated invariant (`pt_init`: "A union
 *      must not invent st_ino… synthetic nodes supply their own from the
 *      ancestor table, in a range no real filesystem here hands out"). Distinct
 *      nodes get distinct inodes is a contract this file already makes.
 *   2. `test -ef` compares (st_dev, st_ino) and is REACHABLE under this ruling:
 *      measured at two `stat` calls and no readdir, which is exactly what an
 *      exempted component allows. Under a collision `[ /root -ef /root/app3 ]`
 *      would answer TRUE, which is plainly false.
 *
 * `getcwd(2)` does NOT observe it — measured on glibc 2.41, it answers from the
 * dentry cache and emits no getdents — and `chdir(2)` compares no inodes. Named
 * here so the property is defended by the mechanisms that actually exercise it.
 */
static void b27_cwd_ino_distinct(void)
{
	static const char *chain[] = { "/", "/root", "/root/app3" };
	unsigned long long ino[3];
	size_t i, j;

	pin("project\t/");                     /* pins[0] */
	pin("project\t/root/app3");            /* pins[1] */
	pin("bind\t/proc");                    /* pins[2] */
	anc_build();
	cwd_path = "/root/app3";

	for (i = 0; i < 3; i++) {
		struct stat st;
		/* POISONED, NOT ZEROED. A mutant that returns 0 without writing the
		 * node would hand back 0xAAAA… here — outside every asserted range
		 * — where a zero-init would have looked like a plausible inode. */
		memset(&st, 0xAA, sizeof(st));
		CHECK(policy_cwd_getattr(chain[i], &st) == 0, "%s answers", chain[i]);
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
 * bites at the LAST component: with `cwd = /root//app3`, `policy_cwd_component`
 * matches `/` and `/root` and then fails on the cwd ITSELF, because the
 * comparison meets the spelling's second '/' against `a`. So the chdir walks
 * every intermediate component and dies at its destination, which is the
 * hardest shape to diagnose from the outside. Asserted below rather than
 * asserted ABOUT.
 *
 * A TRAILING SLASH IS DIFFERENT AND IS REFUSED ANYWAY. `cwd = /root/app3/`
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
	CHECK(policy_cwd_normalised("/root/app3") == 1, "and a plain absolute path");
	CHECK(policy_cwd_normalised("/a") == 1, "and a one-component one");

	CHECK(policy_cwd_normalised("/root/app3/") == 0, "a TRAILING slash is refused");
	CHECK(policy_cwd_normalised("/root//app3") == 0, "so is a doubled slash");
	CHECK(policy_cwd_normalised("//root") == 0, "including a leading doubled slash");
	CHECK(policy_cwd_normalised("/root/./app3") == 0, "so is a `.` component");
	CHECK(policy_cwd_normalised("/root/../app3") == 0, "and a `..` component");
	CHECK(policy_cwd_normalised("/root/..") == 0, "and a trailing `..`");
	CHECK(policy_cwd_normalised("/root/.") == 0, "and a trailing `.`");
	CHECK(policy_cwd_normalised("root/app3") == 0, "a RELATIVE path is refused");
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
	cwd_path = "/root//app3";
	CHECK(policy_cwd_component("/root") == 1,
	      "a doubled-slash cwd still matches the intermediate component");
	CHECK(policy_cwd_component("/root/app3") == 0,
	      "and then fails on the CWD ITSELF, so the chdir dies at its destination");
	/* THE OTHER HALF, AND IT IS THE HONEST ONE: a trailing slash matches
	 * everything, so refusing it buys no behavioural rescue. It is refused
	 * because a non-normalised input is a cc defect, not because the
	 * comparison breaks on it. */
	cwd_path = "/root/app3/";
	CHECK(policy_cwd_component("/root/app3") == 1,
	      "a TRAILING-slash cwd still matches the cwd — the boundary test reads "
	      "the trailing '/' as the separator, so this spelling is refused on "
	      "ownership of the input rather than on a broken comparison");
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
	else if (!strcmp(c, "b17-cwd-exempt")) b17_cwd_exempt(argc, argv);
	else if (!strcmp(c, "b18-cwd-wide-mirror")) b18_cwd_wide_mirror();
	else if (!strcmp(c, "b19-caller-tier-matrix")) b19_caller_tier_matrix();
	else if (!strcmp(c, "b20-caller-sensitive-set")) b20_caller_sensitive_set();
	else if (!strcmp(c, "b21-unmarked-refused-only-at-project")) b21_unmarked_refused_only_at_project();
	else if (!strcmp(c, "b22-cwd-chain-extent")) b22_cwd_chain_extent();
	else if (!strcmp(c, "b24-event-kinds")) b24_event_kinds();
	else if (!strcmp(c, "b25-substitution-logged-at-fail-only")) b25_substitution_logged_at_fail_only();
	else if (!strcmp(c, "b26-cwd-traverse-only")) b26_cwd_traverse_only(argc, argv);
	else if (!strcmp(c, "b27-cwd-ino-distinct")) b27_cwd_ino_distinct();
	else if (!strcmp(c, "b28-cwd-input-validated")) b28_cwd_input_validated();
	else if (!strcmp(c, "frame-vectors")) frame_vectors();
	else { fprintf(stderr, "union-policy-driver: unknown case '%s'\n", c); return 2; }

	if (failures) fprintf(stderr, "%s: %d of %d assertions FAILED\n", c, failures, checks);
	return failures ? 1 : 0;
}

#!/bin/sh
# Reconcile the image's unprivileged account with USER_NAME/USER_UID/USER_GID
# (Dockerfile ARGs, visible here as env vars), then grant it the passwordless
# sudo rule cc's Systems feature requires — see the probe list in
# src/systems/fuse/preflight.ts. Runs as root at build time.
set -eu

: "${USER_NAME:?USER_NAME must be set}"
: "${USER_UID:?USER_UID must be set}"
: "${USER_GID:?USER_GID must be set}"
: "${WITH_SUDO:?WITH_SUDO must be set}"

fail() { echo "FATAL (setup-user): $*" >&2; exit 1; }
warn() { echo "WARNING (setup-user): $*" >&2; }

# ── Refusals ─────────────────────────────────────────────────────────────
# An all-digit name reaches compose's `user:` as a BARE UID — the form that
# skips the passwd lookup and drops every supplementary group, which is the
# failure this reconcile exists to prevent. sudo would not match it either:
# a sudoers rule names a numeric user only with a '#' prefix.
case "$USER_NAME" in
  *[!0-9]*) ;;
  *) fail "CC_USER='$USER_NAME' is all digits; it must be an account NAME. Put the numeric id in CC_UID instead." ;;
esac

case "$USER_UID$USER_GID" in
  *[!0-9]*) fail "CC_UID/CC_GID must be numeric; got $USER_UID/$USER_GID." ;;
esac
# Both defeat the uid separation the entrypoint's writability guards and the
# CC_PROJECTS_DIR ownership rule are built on.
if [ "$USER_UID" = "0" ]; then
  fail "CC_UID=0 would run the server, every spawned session and every FUSE mount as real root. Set CC_UID/CC_GID to the owner of CC_PROJECTS_DIR (stat -c '%u %g' <dir>)."
fi
if [ "$USER_GID" = "0" ]; then
  fail "CC_GID=0 would give the container the root group, so everything it creates is group-root. Set CC_UID/CC_GID to the owner of CC_PROJECTS_DIR (stat -c '%u %g' <dir>)."
fi

# ── Facts ────────────────────────────────────────────────────────────────
# The pipeline's status is cut's, so an absent entry yields an empty string
# rather than tripping `set -e`.
group_gid="$(getent group "$USER_NAME" | cut -d: -f3)"
gid_holder="$(getent group "$USER_GID" | cut -d: -f1)"
acct_uid="$(getent passwd "$USER_NAME" | cut -d: -f3)"
acct_gid="$(getent passwd "$USER_NAME" | cut -d: -f4)"
uid_holder="$(getent passwd "$USER_UID" | cut -d: -f1)"

# ── Conflicts ────────────────────────────────────────────────────────────
# Collected BEFORE anything is applied, so the failure names every id that is
# actually in the way rather than whichever branch happens to run first. No
# pre-existing account or group is ever renumbered to make room.
conflicts=""
note() { conflicts="${conflicts:+$conflicts; }$1"; }

if [ -n "$group_gid" ] && [ "$group_gid" != "$USER_GID" ] \
   && [ -n "$gid_holder" ] && [ "$gid_holder" != "$USER_NAME" ]; then
  note "gid $USER_GID (CC_GID) is held by group '$gid_holder'"
fi
if [ -n "$acct_uid" ]; then
  if { [ "$acct_uid" != "$USER_UID" ] || [ "$acct_gid" != "$USER_GID" ]; } \
     && [ -n "$uid_holder" ] && [ "$uid_holder" != "$USER_NAME" ]; then
    note "uid $USER_UID (CC_UID) is held by account '$uid_holder'"
  fi
elif [ -n "$uid_holder" ]; then
  note "uid $USER_UID (CC_UID) is held by account '$uid_holder'"
fi
[ -z "$conflicts" ] || fail "cannot give account '$USER_NAME' uid $USER_UID / gid $USER_GID in this base image: $conflicts. Pick ids that match the owner of CC_PROJECTS_DIR and are free here, or a base image where they are (CC_BASE_IMAGE / CC_BASE_IMAGE_FILE)."

# ── Group ────────────────────────────────────────────────────────────────
if [ -n "$group_gid" ]; then
  if [ "$group_gid" != "$USER_GID" ]; then
    warn "group '$USER_NAME' already exists in this base image with gid $group_gid; renumbering it to $USER_GID. Files already owned by gid $group_gid keep it."
    groupmod -g "$USER_GID" "$USER_NAME"
  fi
elif [ -z "$gid_holder" ]; then
  groupadd -g "$USER_GID" "$USER_NAME"
else
  warn "gid $USER_GID (CC_GID) is held by group '$gid_holder'; '$USER_NAME' joins THAT group instead of getting one of its own."
fi

# ── User ─────────────────────────────────────────────────────────────────
if [ -n "$acct_uid" ]; then
  if [ "$acct_uid" != "$USER_UID" ] || [ "$acct_gid" != "$USER_GID" ]; then
    warn "account '$USER_NAME' already exists in this base image with uid $acct_uid gid $acct_gid; renumbering it to $USER_UID:$USER_GID."
    # -u re-chowns files under the home directory to the new uid; -g
    # propagates NOTHING, so they keep gid $acct_gid — dangling once the
    # group above has moved. Files owned elsewhere keep both old ids. Neither
    # matters at runtime: $HOME is on the projects bind, not in the image.
    usermod -u "$USER_UID" -g "$USER_GID" "$USER_NAME"
  fi
else
  useradd --no-log-init --create-home --shell /bin/bash \
    -u "$USER_UID" -g "$USER_GID" "$USER_NAME"
fi

# ── Sudoers (WITH_SUDO) ──────────────────────────────────────────────────
# NOPASSWD is the whole of it: nothing cc means the mount bootstrap or the
# worker to have travels through sudo, so the rule needs no SETENV tag
# (src/systems/fuse/wrap.ts). visudo -cf makes a malformed rule fail the build
# instead of the first spawn.
if [ "$WITH_SUDO" = "1" ]; then
  # A uid below 1000 is a system account: it exists in the base image for
  # something other than this, so say so before handing it passwordless root.
  if [ -n "$acct_uid" ] && [ "$USER_UID" -lt 1000 ]; then
    warn "'$USER_NAME' is a pre-existing system account (uid $USER_UID) and now has passwordless root."
  fi
  sudoers=/etc/sudoers.d/cc-conductor
  printf '%s ALL=(ALL:ALL) NOPASSWD: ALL\n' "$USER_NAME" > "$sudoers"
  chmod 0440 "$sudoers"
  visudo -cf "$sudoers"
fi

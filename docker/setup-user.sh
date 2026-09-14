#!/bin/sh
# Reconcile the image's unprivileged account with USER_NAME/USER_UID/USER_GID
# (Dockerfile ARGs, visible here as env vars), then grant it the passwordless
# SETENV sudo rule cc's Systems feature requires — see the probe list in
# src/systems/fuse/preflight.ts. Runs as root at build time.
set -eu

: "${USER_NAME:?USER_NAME must be set}"
: "${USER_UID:?USER_UID must be set}"
: "${USER_GID:?USER_GID must be set}"

fail() { echo "FATAL (setup-user): $*" >&2; exit 1; }

# ── Group ────────────────────────────────────────────────────────────────
# The pipeline's status is cut's, so an absent entry yields an empty string
# rather than tripping `set -e`.
group_gid="$(getent group "$USER_NAME" | cut -d: -f3)"
gid_holder="$(getent group "$USER_GID" | cut -d: -f1)"

if [ -n "$group_gid" ]; then
  if [ "$group_gid" != "$USER_GID" ]; then
    if [ -n "$gid_holder" ] && [ "$gid_holder" != "$USER_NAME" ]; then
      fail "cannot give group '$USER_NAME' gid $USER_GID — group '$gid_holder' already holds it in this base image. Pick a different CC_GID (matching the owner of CC_PROJECTS_DIR), or a base image whose gid $USER_GID is free (CC_BASE_IMAGE / CC_BASE_IMAGE_FILE)."
    fi
    groupmod -g "$USER_GID" "$USER_NAME"
  fi
elif [ -z "$gid_holder" ]; then
  groupadd -g "$USER_GID" "$USER_NAME"
fi
# Group absent and gid taken: no group is created; the account joins the
# existing group that holds $USER_GID.

# ── User ─────────────────────────────────────────────────────────────────
user_uid="$(getent passwd "$USER_NAME" | cut -d: -f3)"
user_gid="$(getent passwd "$USER_NAME" | cut -d: -f4)"
uid_holder="$(getent passwd "$USER_UID" | cut -d: -f1)"

if [ -n "$user_uid" ]; then
  if [ "$user_uid" != "$USER_UID" ] || [ "$user_gid" != "$USER_GID" ]; then
    if [ -n "$uid_holder" ] && [ "$uid_holder" != "$USER_NAME" ]; then
      fail "cannot give account '$USER_NAME' uid $USER_UID — account '$uid_holder' already holds it in this base image. Pick a different CC_UID (matching the owner of CC_PROJECTS_DIR), or a base image whose uid $USER_UID is free (CC_BASE_IMAGE / CC_BASE_IMAGE_FILE)."
    fi
    # usermod re-chowns the home directory's contents itself.
    usermod -u "$USER_UID" -g "$USER_GID" "$USER_NAME"
  fi
else
  if [ -n "$uid_holder" ]; then
    fail "cannot create account '$USER_NAME' with uid $USER_UID — account '$uid_holder' already holds it in this base image. Pick a different CC_UID (matching the owner of CC_PROJECTS_DIR), or a base image whose uid $USER_UID is free (CC_BASE_IMAGE / CC_BASE_IMAGE_FILE)."
  fi
  useradd --no-log-init --create-home --shell /bin/bash \
    -u "$USER_UID" -g "$USER_GID" "$USER_NAME"
fi

# ── Sudoers ──────────────────────────────────────────────────────────────
# NOPASSWD alone is not enough: the mount plan rides in CC_FUSE_* environment
# variables through `sudo -n -E`, which needs the SETENV tag. visudo -c makes a
# malformed rule fail the build instead of the first spawn.
sudoers=/etc/sudoers.d/cc-conductor
printf '%s ALL=(ALL:ALL) NOPASSWD:SETENV: ALL\n' "$USER_NAME" > "$sudoers"
chmod 0440 "$sudoers"
visudo -cf "$sudoers"

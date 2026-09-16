#!/bin/bash

# Installed on EC2 and invoked through SSM. AWS access comes from the instance
# profile; no AWS credentials are accepted as options.

set -u
umask 077

CONFIG_FILE="${OC_HANDOFF_CLOUD_CONFIG:-/etc/oc-handoff/cloud.env}"
if [[ -r "$CONFIG_FILE" ]]; then
  . "$CONFIG_FILE"
fi

BUCKET=""
HANDOFF_ID=""
DESTINATION=""
CLOUD_USER="developer"
PYTHON_BIN="${OC_PYTHON_BIN:-python3}"
AWS_REGION="${AWS_REGION:-us-west-2}"
STATE_ROOT="${OC_HANDOFF_STATE_ROOT:-/home/developer/.local/share/oc-handoff/incoming}"

die() { printf '%s\n' "oc-handoff-cloud: $*" >&2; exit 1; }
valid_id() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; }
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

s3_get() {
  "$PYTHON_BIN" - "$BUCKET" "$1" "$2" <<'PY'
import boto3
import sys
boto3.client("s3", region_name="us-west-2").download_file(sys.argv[1], sys.argv[2], sys.argv[3])
PY
}

s3_put() {
  "$PYTHON_BIN" - "$BUCKET" "$1" "$2" <<'PY'
import boto3
import sys
boto3.client("s3", region_name="us-west-2").upload_file(sys.argv[3], sys.argv[1], sys.argv[2], ExtraArgs={"ServerSideEncryption": "AES256"})
PY
}

s3_head() {
  "$PYTHON_BIN" - "$BUCKET" "$1" <<'PY'
import boto3
import sys
boto3.client("s3", region_name="us-west-2").head_object(Bucket=sys.argv[1], Key=sys.argv[2])
PY
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket) [[ $# -ge 2 ]] || die "missing bucket"; BUCKET="$2"; shift 2 ;;
    --handoff-id) [[ $# -ge 2 ]] || die "missing handoff ID"; HANDOFF_ID="$2"; shift 2 ;;
    --destination) [[ $# -ge 2 ]] || die "missing destination"; DESTINATION="$2"; shift 2 ;;
    --cloud-user) [[ $# -ge 2 ]] || die "missing cloud user"; CLOUD_USER="$2"; shift 2 ;;
    *) die "unknown option" ;;
  esac
done
[[ -n "$BUCKET" && -n "$HANDOFF_ID" && -n "$DESTINATION" ]] || die "bucket, handoff ID, and destination are required"
valid_id "$HANDOFF_ID" || die "invalid handoff ID"
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "invalid bucket name"
[[ "$DESTINATION" == /home/developer/workspace/intangibility ]] || die "destination is not the configured cloud repository"
[[ "$CLOUD_USER" == developer ]] || die "only the developer cloud user is supported in v1"
command -v "$PYTHON_BIN" >/dev/null 2>&1 || die "Python is unavailable"
[[ "$(id -u)" == 0 ]] || die "cloud helper must run as root through SSM"
[[ -d "$DESTINATION/.git" || -f "$DESTINATION/.git" ]] || die "destination is not a Git repository"
[[ -z "$(git -C "$DESTINATION" status --porcelain 2>/dev/null)" ]] || die "cloud repository is not clean"
upstream="$(git -C "$DESTINATION" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null)" || die "cloud repository has no upstream branch"
counts="$(git -C "$DESTINATION" rev-list --left-right --count HEAD..."$upstream" 2>/dev/null)" || die "could not compare cloud repository with upstream"
read -r behind ahead <<< "$counts"
[[ "$ahead" == 0 && "$behind" == 0 ]] || die "cloud repository is not pushed and current"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/oc-handoff-cloud.XXXXXX")" || die "could not create private staging directory"
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
prefix="v1/$HANDOFF_ID"
s3_head "$prefix/ready" >/dev/null 2>&1 || die "handoff is not ready"
s3_get "$prefix/manifest.json" "$tmp/manifest.json" || die "could not download manifest"
s3_get "$prefix/session.json" "$tmp/session.json" || die "could not download session artifact"
chmod 600 "$tmp/manifest.json" "$tmp/session.json"

metadata="$($PYTHON_BIN - "$tmp/manifest.json" "$HANDOFF_ID" "$DESTINATION" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    manifest = json.load(stream)
if manifest.get("schema") != "opencode-handoff/v1": raise SystemExit("unsupported manifest")
if manifest.get("handoff_id") != sys.argv[2]: raise SystemExit("handoff ID mismatch")
if manifest.get("destination_repo") != sys.argv[3]: raise SystemExit("destination mismatch")
if manifest.get("artifact") != "session.json": raise SystemExit("unsupported artifact")
if not re.fullmatch(r"[0-9a-f]{64}", manifest.get("sha256", "")): raise SystemExit("invalid checksum")
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", manifest.get("session_id", "")): raise SystemExit("invalid session ID")
print("\t".join((manifest["session_id"], manifest["sha256"])))
PY
)" || die "manifest validation failed"
IFS=$'\t' read -r session_id expected_sha <<< "$metadata"
[[ "$(sha256_file "$tmp/session.json")" == "$expected_sha" ]] || die "session checksum mismatch"

mkdir -p "$STATE_ROOT" || die "could not create cloud handoff state directory"
chmod 700 "$STATE_ROOT"
stage="$STATE_ROOT/.$HANDOFF_ID.tmp"
final="$STATE_ROOT/$HANDOFF_ID"
[[ ! -e "$final" ]] || die "handoff has already been received"
rm -rf "$stage"
mkdir "$stage" || die "could not create atomic staging directory"
chmod 700 "$stage"
cp "$tmp/session.json" "$stage/session.json"
cp "$tmp/manifest.json" "$stage/manifest.json"
chmod 600 "$stage/session.json" "$stage/manifest.json"
mv "$stage" "$final"
chown "$CLOUD_USER:$CLOUD_USER" "$STATE_ROOT" "$final"

result_path="$final/.result.json"
imported=false
if [[ -n "${OC_CLOUD_SESSION_IMPORTER:-}" ]]; then
  [[ -x "$OC_CLOUD_SESSION_IMPORTER" ]] || die "configured cloud session importer is not executable"
  [[ "$(id -u)" == 0 ]] || die "cloud session importer requires the SSM helper to run as root"
  command -v runuser >/dev/null 2>&1 || die "runuser is required for the cloud session importer"
    runuser -u "$CLOUD_USER" -- "$OC_CLOUD_SESSION_IMPORTER" "$final/session.json" "$DESTINATION" "$session_id" "$result_path" >/dev/null 2>&1 || die "cloud session importer failed"
  imported=true
fi

if [[ -s "$result_path" ]]; then
  "$PYTHON_BIN" - "$result_path" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as stream:
    value = json.load(stream)
if not isinstance(value, (dict, list)):
    raise SystemExit("importer result must be an object or array")
PY
  chmod 600 "$result_path"
  result_sha="$(sha256_file "$result_path")"
  s3_put "$prefix/result.json" "$result_path" || die "could not publish importer result"
else
  result_sha=""
fi

receipt="$tmp/receipt.json"
"$PYTHON_BIN" - "$receipt" "$HANDOFF_ID" "$session_id" "$DESTINATION" "$imported" "$result_sha" <<'PY'
import datetime
import json
import sys

path, handoff_id, session_id, destination, imported, result_sha = sys.argv[1:]
receipt = {
    "schema": "opencode-handoff-receipt/v1",
    "handoff_id": handoff_id,
    "session_id": session_id,
    "destination_repo": destination,
    "status": "imported" if imported == "true" else "staged",
    "result_sha256": result_sha or None,
    "created_at": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
}
with open(path, "w", encoding="utf-8") as stream:
    json.dump(receipt, stream, sort_keys=True, separators=(",", ":"))
    stream.write("\n")
PY
chmod 600 "$receipt"
s3_put "$prefix/receipt.json" "$receipt" || die "could not publish handoff receipt"
printf 'Handoff %s staged for %s (%s).\n' "$HANDOFF_ID" "$DESTINATION" "$imported"

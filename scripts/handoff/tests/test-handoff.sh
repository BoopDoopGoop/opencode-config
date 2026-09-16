#!/bin/bash

set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TEMP="$(mktemp -d "${TMPDIR:-/tmp}/oc-handoff-test.XXXXXX")"
trap 'rm -rf "$TEMP"' EXIT HUP INT TERM

assert_contains() {
  case "$1" in *"$2"*) ;; *) printf 'expected %s to contain %s\n' "$1" "$2" >&2; exit 1 ;; esac
}

mkdir -p "$TEMP/bin" "$TEMP/mock-s3"
cat > "$TEMP/bin/exporter" <<'EOF'
#!/bin/bash
set -eu
if [[ "$1" == --check ]]; then exit 0; fi
printf '{"session":"test-only","messages":[]}' > "$2"
EOF
chmod 700 "$TEMP/bin/exporter"

cat > "$TEMP/bin/aws" <<'EOF'
#!/bin/bash
set -eu
root="${MOCK_S3:?}"
op=""
for arg in "$@"; do
  if [[ "$arg" == s3api || "$arg" == ssm ]]; then op="$arg"; fi
done
if [[ "$op" == ssm ]]; then
  case " $* " in
    *" send-command "*) printf 'command-test\n' ;;
    *" get-command-invocation "*) printf 'Success\n' ;;
  esac
  exit 0
fi
action=""
for arg in "$@"; do
  case "$arg" in
    put-object|copy-object|get-object|head-object) action="$arg" ;;
  esac
done
value() {
  local key="$1"; shift
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "$key" ]]; then printf '%s' "$2"; return; fi
    shift 2
  done
}
key="$(value --key "$@")"
path="$root/$key"
mkdir -p "$(dirname "$path")"
case "$action" in
  put-object) cp "$(value --body "$@")" "$path" ;;
  copy-object) source_key="$(value --copy-source "$@")"; cp "$root/${source_key#*/}" "$path" ;;
  head-object) [[ -f "$path" ]] ;;
  get-object) cp "$path" "$(value --output "$@")" 2>/dev/null || cp "$path" "${@: -1}" ;;
esac
EOF
chmod 700 "$TEMP/bin/aws"

git init --bare "$TEMP/remote.git" >/dev/null
git clone "$TEMP/remote.git" "$TEMP/source" >/dev/null 2>&1
git -C "$TEMP/source" config user.email test@example.invalid
git -C "$TEMP/source" config user.name test
printf 'tracked\n' > "$TEMP/source/file.txt"
git -C "$TEMP/source" add file.txt
git -C "$TEMP/source" commit -m initial >/dev/null
git -C "$TEMP/source" push -u origin HEAD >/dev/null 2>&1

handoff_output="$(
  OC_AWS_BIN="$TEMP/bin/aws" MOCK_S3="$TEMP/mock-s3" \
  OC_HANDOFF_BUCKET=test-mailbox OC_LOCAL_SESSION_EXPORTER="$TEMP/bin/exporter" \
  OC_HANDOFF_POLL_INTERVAL=0 "$ROOT/oc-handoff" cloud session-test \
    --source "$TEMP/source" --destination /home/developer/workspace/intangibility
)"
assert_contains "$handoff_output" 'Handoff created: oc-'
if [[ "$handoff_output" == *'session'* ]]; then
  printf 'handoff output must not contain session JSON\n' >&2
  exit 1
fi

printf 'dirty\n' >> "$TEMP/source/file.txt"
if OC_AWS_BIN="$TEMP/bin/aws" MOCK_S3="$TEMP/mock-s3" \
  OC_HANDOFF_BUCKET=test-mailbox OC_LOCAL_SESSION_EXPORTER="$TEMP/bin/exporter" \
  "$ROOT/oc-handoff" cloud session-test --source "$TEMP/source" \
  --destination /home/developer/workspace/intangibility >/dev/null 2>&1; then
  printf 'dirty source should have failed\n' >&2
  exit 1
fi

printf 'handoff tests passed\n'

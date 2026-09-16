#!/bin/bash

set -euo pipefail
umask 077

SESSION_JSON="${1:-}"
DESTINATION="${2:-}"
SESSION_ID="${3:-}"
RESULT_JSON="${4:-}"

die() {
  printf '%s\n' "oc-handoff-importer: $*" >&2
  exit 1
}

[[ -f "$SESSION_JSON" ]] || die "session artifact does not exist"
[[ "$DESTINATION" == "/home/developer/workspace/intangibility" ]] || die "unexpected destination"
[[ "$SESSION_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]] || die "invalid session ID"
[[ "$RESULT_JSON" == /* ]] || die "result path must be absolute"

cd "$DESTINATION"
if ! imported="$({
  export HOME=/home/developer
  export XDG_CONFIG_HOME=/home/developer/.config
  export XDG_DATA_HOME=/home/developer/.local/share
  export XDG_STATE_HOME=/home/developer/.local/state
  /usr/local/bin/opencode-server import "$SESSION_JSON"
} 2>&1)"; then
  die "OpenCode import failed"
fi

python3 - "$RESULT_JSON" "$SESSION_ID" "$imported" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, session_id, output = sys.argv[1:]
with open(path, "w", encoding="utf-8") as stream:
    json.dump(
        {
            "schema": "opencode-handoff-import-result/v1",
            "session_id": session_id,
            "import_output": output[-2000:],
            "imported_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        },
        sort_keys=True,
        separators=(",", ":"),
        stream=stream,
    )
    stream.write("\n")
PY
chmod 600 "$RESULT_JSON"

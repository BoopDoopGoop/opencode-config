#!/bin/zsh

# @raycast.schemaVersion 1
# @raycast.title Restart OpenCode Cloud
# @raycast.mode compact
# @raycast.packageName OpenCode
# @raycast.description Restarts the cloud OpenCode service and verifies its health endpoint.

set -u

export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

AWS="/opt/homebrew/bin/aws"
CURL="/usr/bin/curl"
OSASCRIPT="/usr/bin/osascript"
PROFILE="henry-admin"
REGION="us-west-2"
INSTANCE_ID="i-05af73c4442480896"
HEALTH_URL="https://henry-opencode-workspace.tail0fb1b8.ts.net/global/health"
POLL_INTERVAL=2
SSM_TIMEOUT=120
HEALTH_TIMEOUT=60

notify() {
  local title="$1"
  local message="$2"

  "$OSASCRIPT" - "$title" "$message" >/dev/null 2>&1 <<'APPLESCRIPT' || true
on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run
APPLESCRIPT
}

fail() {
  local message="$1"

  print -r -- "$message"
  notify "OpenCode restart failed" "$message"
  exit 1
}

[[ -x "$AWS" ]] || fail "AWS CLI is unavailable at $AWS."
[[ -x "$CURL" ]] || fail "curl is unavailable at $CURL."

print "Sending cloud restart command..."
command_id="$(
  "$AWS" ssm send-command \
    --profile "$PROFILE" \
    --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --comment "Restart cloud OpenCode" \
    --timeout-seconds 60 \
    --parameters 'commands=["systemctl restart opencode.service","systemctl is-active --quiet opencode.service"]' \
    --query 'Command.CommandId' \
    --output text 2>/dev/null
)" || fail "Could not send the cloud restart command."

[[ -n "$command_id" && "$command_id" != "None" ]] || fail "AWS did not return a restart command ID."

print "Waiting for SSM command $command_id..."
ssm_status=""
for ((attempt = 1; attempt <= SSM_TIMEOUT / POLL_INTERVAL; attempt++)); do
  ssm_status="$(
    "$AWS" ssm get-command-invocation \
      --profile "$PROFILE" \
      --region "$REGION" \
      --command-id "$command_id" \
      --instance-id "$INSTANCE_ID" \
      --query 'Status' \
      --output text 2>/dev/null
  )" || ssm_status=""

  case "$ssm_status" in
    Success)
      break
      ;;
    Failed|Cancelled|TimedOut|Cancelling)
      fail "Cloud restart failed (SSM: $ssm_status; command: $command_id)."
      ;;
  esac

  /bin/sleep "$POLL_INTERVAL"
done

[[ "$ssm_status" == "Success" ]] || fail "Cloud restart timed out (command: $command_id)."

print "Checking OpenCode HTTPS health..."
health=""
for ((attempt = 1; attempt <= HEALTH_TIMEOUT / POLL_INTERVAL; attempt++)); do
  health="$("$CURL" --fail --silent --show-error --connect-timeout 5 --max-time 10 "$HEALTH_URL" 2>/dev/null)" && break
  /bin/sleep "$POLL_INTERVAL"
done

[[ -n "$health" ]] || fail "OpenCode restarted, but its HTTPS health check timed out."

health="${health//$'\n'/ }"
print "OpenCode restarted. Health: $health"
notify "OpenCode restarted" "Cloud health check passed."

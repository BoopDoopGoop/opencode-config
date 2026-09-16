#!/bin/bash

# Install the fixed helper with one SSM command. The helper is staged in the
# already-provisioned mailbox rather than placed in an oversized SSM parameter.

set -u
PROFILE="${AWS_PROFILE:-henry-admin}"
REGION="${AWS_REGION:-us-west-2}"
INSTANCE_ID="${OC_HANDOFF_INSTANCE_ID:-i-05af73c4442480896}"
AWS_BIN="${OC_AWS_BIN:-aws}"
TARGET="${OC_HANDOFF_CLOUD_HELPER:-/usr/local/libexec/oc-handoff-cloud}"
SOURCE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/cloud-helper.sh"
IMPORTER_SOURCE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/cloud-importer.sh"
BUCKET="${OC_HANDOFF_BUCKET:-}"
IMPORTER_TARGET="${OC_HANDOFF_CLOUD_IMPORTER:-/usr/local/libexec/oc-handoff-importer}"

die() { printf '%s\n' "install-cloud-helper: $*" >&2; exit 1; }
[[ -x "$SOURCE" ]] || die "cloud-helper.sh is not executable"
[[ -x "$IMPORTER_SOURCE" ]] || die "cloud-importer.sh is not executable"
[[ "$TARGET" == /* && "$TARGET" != *"'"* && "$TARGET" != *" "* ]] || die "target path must be absolute without spaces or quotes"
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "OC_HANDOFF_BUCKET must be a valid S3 bucket name"
command -v "$AWS_BIN" >/dev/null 2>&1 || die "AWS CLI is unavailable"

key="v1/_bootstrap/cloud-helper-$(openssl rand -hex 12 2>/dev/null).sh"
importer_key="v1/_bootstrap/cloud-importer-$(openssl rand -hex 12 2>/dev/null).sh"
"$AWS_BIN" --profile "$PROFILE" --region "$REGION" s3api put-object --bucket "$BUCKET" --key "$key" \
  --body "$SOURCE" --server-side-encryption AES256 >/dev/null || die "could not stage helper in mailbox"
"$AWS_BIN" --profile "$PROFILE" --region "$REGION" s3api put-object --bucket "$BUCKET" --key "$importer_key" \
  --body "$IMPORTER_SOURCE" --server-side-encryption AES256 >/dev/null || die "could not stage importer in mailbox"
commands="install -d -m 0755 '$(dirname "$TARGET")'; python3 -c 'import boto3,os; c=boto3.client(\"s3\",region_name=\"$REGION\"); c.download_file(\"$BUCKET\",\"$key\",\"$TARGET\"); c.download_file(\"$BUCKET\",\"$importer_key\",\"$IMPORTER_TARGET\"); os.chmod(\"$TARGET\",0o755); os.chmod(\"$IMPORTER_TARGET\",0o755)' ; chown root:root '$TARGET' '$IMPORTER_TARGET'"
command_id="$($AWS_BIN --profile "$PROFILE" --region "$REGION" ssm send-command \
  --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
  --comment 'Install OpenCode handoff helper' --timeout-seconds 60 \
  --parameters "commands=[\"$commands\"]" --query 'Command.CommandId' --output text 2>/dev/null)" || die "could not send installation command"
[[ -n "$command_id" && "$command_id" != None ]] || die "SSM did not return a command ID"
for ((attempt = 1; attempt <= 30; attempt++)); do
  status="$($AWS_BIN --profile "$PROFILE" --region "$REGION" ssm get-command-invocation \
    --command-id "$command_id" --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null)" || status=""
  case "$status" in
      Success)
      "$AWS_BIN" --profile "$PROFILE" --region "$REGION" s3api delete-object --bucket "$BUCKET" --key "$key" >/dev/null 2>&1 || true
      "$AWS_BIN" --profile "$PROFILE" --region "$REGION" s3api delete-object --bucket "$BUCKET" --key "$importer_key" >/dev/null 2>&1 || true
      printf 'Cloud helper installed at %s.\n' "$TARGET"
      exit 0
      ;;
    Failed|Cancelled|TimedOut|Cancelling) die "helper installation failed (SSM: $status)" ;;
  esac
  sleep 2
done
die "helper installation timed out (command: $command_id)"

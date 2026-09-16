#!/bin/bash

# Idempotent mailbox provisioning. It intentionally does not change IAM roles.

set -u
PROFILE="${AWS_PROFILE:-henry-admin}"
REGION="${AWS_REGION:-us-west-2}"
AWS_BIN="${OC_AWS_BIN:-aws}"
BUCKET="${1:-}"

die() { printf '%s\n' "provision-mailbox: $*" >&2; exit 1; }
[[ -n "$BUCKET" && "$BUCKET" != -* ]] || die "usage: provision-mailbox.sh <globally-unique-bucket-name>"
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "invalid S3 bucket name"
[[ "$REGION" == us-west-2 ]] || die "this v1 manifest is fixed to us-west-2"
command -v "$AWS_BIN" >/dev/null 2>&1 || die "AWS CLI is unavailable"

if ! "$AWS_BIN" --profile "$PROFILE" --region "$REGION" s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  "$AWS_BIN" --profile "$PROFILE" --region "$REGION" s3api create-bucket --bucket "$BUCKET" \
    --create-bucket-configuration LocationConstraint="$REGION" >/dev/null || die "could not create bucket"
fi
"$AWS_BIN" --profile "$PROFILE" --region "$REGION" s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null || die "could not enable public access block"
"$AWS_BIN" --profile "$PROFILE" --region "$REGION" s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null || die "could not enable bucket encryption"
"$AWS_BIN" --profile "$PROFILE" --region "$REGION" s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration '{"Rules":[{"ID":"expire-opencode-handoffs-after-24-hours","Status":"Enabled","Filter":{"Prefix":"v1/"},"Expiration":{"Days":1},"NoncurrentVersionExpiration":{"NoncurrentDays":1}}]}' >/dev/null || die "could not configure lifecycle"

printf 'Mailbox ready: s3://%s (region %s)\n' "$BUCKET" "$REGION"
printf 'Set OC_HANDOFF_BUCKET=%s on the Mac.\n' "$BUCKET"
printf 'Instance-profile actions required: s3:HeadObject, s3:GetObject, s3:PutObject on arn:aws:s3:::%s/v1/*\n' "$BUCKET"
printf 'Local-profile actions required: s3:PutObject, s3:GetObject on arn:aws:s3:::%s/v1/*\n' "$BUCKET"

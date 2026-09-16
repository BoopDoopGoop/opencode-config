# OpenCode v1 handoff

This is a small SSM + private S3 mailbox. It supports the one cloud
repository `/home/developer/workspace/intangibility` on instance
`i-05af73c4442480896` in `us-west-2`.

## One-time setup

Choose a globally unique bucket name and run:

```sh
scripts/handoff/provision-mailbox.sh my-private-opencode-handoff-<unique>
scripts/handoff/install-cloud-helper.sh
```

The first command enables public-access blocking, AES-256 server-side
encryption, and a 24-hour lifecycle rule. It does not alter IAM. The EC2
instance profile needs `s3:GetObject` and `s3:PutObject` for
`arn:aws:s3:::BUCKET/v1/*`; the local profile needs put/copy/get access to the
same prefix. Use the exact bucket name printed by provisioning.

## Local exporter compatibility boundary

`oc-handoff` does not pretend that OpenCode Desktop's session database is a
portable CLI format. Set `OC_LOCAL_SESSION_EXPORTER` to an executable that
supports:

```text
exporter --check
exporter SESSION_ID OUTPUT_FILE
```

`--check` should verify that the installed local OpenCode CLI/storage adapter
is compatible. The second invocation must write one JSON object or array to
`OUTPUT_FILE`; the client keeps it mode 0600 and never prints it. A helper may
wrap an absolute OpenCode CLI path when `opencode` is not on `PATH`.

## Commands

```sh
export OC_HANDOFF_BUCKET=my-private-opencode-handoff-<unique>
export OC_LOCAL_SESSION_EXPORTER="$HOME/bin/oc-export-session"

scripts/handoff/oc-handoff cloud SESSION_ID \
  --source "$HOME/src/intangibility" \
  --destination /home/developer/workspace/intangibility

scripts/handoff/oc-handoff receive HANDOFF_ID --output "$HOME/.oc-handoff"
```

The source repository must be clean, have an upstream branch, and have zero
ahead or behind commits. The cloud helper applies the same checks to the fixed
destination before atomically staging the session under
`/home/developer/.local/share/oc-handoff/incoming/<handoff-id>`. No repository
files are changed. A receipt reports `staged` unless an importer is configured.

To connect the staged artifact to cloud OpenCode, install a reviewed wrapper
and set `OC_CLOUD_SESSION_IMPORTER` in `/etc/oc-handoff/cloud.env`. Its
interface is:

```text
importer SESSION_JSON DESTINATION_REPO SESSION_ID RESULT_JSON
```

It must write a JSON result to `RESULT_JSON` if a result is available. The
helper runs it as the `developer` user and uploads only that JSON result.
There is no Tailscale or OpenCode service modification in this v1 flow.

`receive` downloads the receipt and optional result into a mode-0700 directory
with mode-0600 files. Mailbox objects expire after 24 hours.

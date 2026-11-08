# Lulutong offline data backup

Archives the original Lulutong `an.db` offline data package in GitHub Releases.
Despite its extension, `an.db` is a ZIP/JAR of binary timetable files, not a
database. Binary packages are not committed to Git.

## Scheduled backups

GitHub Actions checks daily at **10:23 Asia/Shanghai (02:23 UTC)**. You can also
open **Actions → Offline data backup → Run workflow** to run a backup manually.
Pushes and pull requests run typechecks and local fixture tests, not backups.
The workflow uses the repository's `GITHUB_TOKEN`; no extra secret is required.

Each check reads `http://down.lltskb.com/android.ver`, downloads from its mirrors
in order, decompresses the archive, checks the required members and `ver.txt`,
and calculates SHA-256. It downloads even when the advertised version is
unchanged, so a same-version revision can be archived. Validation checks the
archive structure, not the meaning of every timetable record.

A release tag is `llt-<publisher-version>-<full-sha256>`. A published tag is never
overwritten. If it already exists, the run finishes without uploading. Uploads
are staged in a draft release; a later run for the same package replaces any
partial draft assets and publishes only after all three assets upload:

- `an.db`: the unmodified offline data package.
- `android.ver`: the unmodified publisher metadata fetched for this acquisition.
- `manifest.json`: publisher version, package SHA-256 and byte size, source URL,
  metadata URL, and retrieval time in UTC.

The Releases list is the archive index. The latest release is the most recently
published archive, not necessarily the highest publisher version.

GitHub schedules can be delayed or dropped. Daily polling can miss revisions
that disappear between checks. If the repository becomes public, GitHub also
disables scheduled workflows after 60 days without repository activity.
See [GitHub's scheduling documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

The publisher currently serves these files over HTTP. SHA-256 identifies the
downloaded bytes; it does not authenticate the publisher.

## Local use

Requires Node.js 24 or newer. Install dependencies and check the code:

```sh
npm ci
npm run typecheck
npm test
```

To publish a backup from a local checkout, authenticate GitHub CLI with write
access to this repository, then run:

```sh
GH_TOKEN="$(gh auth token)" \
GITHUB_REPOSITORY=situ2001/llt-data-backup \
GITHUB_SHA="$(git rev-parse HEAD)" \
npm run backup
```

This command creates a GitHub Release when it finds a package not yet archived.
Network, validation, and GitHub API failures exit with a nonzero status.

## Data ownership

Lulutong owns the upstream material. Keep this repository and its archives
private unless redistribution permission has been established.

Acquisition and validation rules originate in
[`12306-parser/packages/llt-provider`](https://github.com/situ2001/12306-parser/tree/main/packages/llt-provider).

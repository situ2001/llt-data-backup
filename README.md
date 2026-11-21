# Lulutong offline data backup

Archives Lulutong's original `an.db` timetable package (ZIP/JAR) in GitHub
Releases.

## Scheduled backups

The workflow runs daily and publishes a release when it finds a new version or
a revised package for an existing version.

## Local use

With Node.js 24 or newer, install dependencies and run checks.

```sh
npm ci
npm run typecheck
npm test
```

import { Effect, Schema } from "effect";
import { fetchPackage } from "./package.ts";

const Release = Schema.Struct({
  id: Schema.Number,
  tag_name: Schema.String,
  draft: Schema.Boolean,
  html_url: Schema.String,
  assets: Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String })),
});

export interface BackupOptions {
  repository: string;
  token: string;
  commit: string;
}

export function backup(options: BackupOptions, fetcher: typeof fetch = fetch) {
  const { repository, token, commit } = options;
  const api = `https://api.github.com/repos/${repository}/releases`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2026-03-10",
  };

  function request(url: string, init: RequestInit = {}) {
    return Effect.tryPromise({
      try: async signal => {
        const response = await fetcher(url, {
          ...init,
          headers: { ...headers, ...init.headers },
          signal,
        });
        if (!response.ok) {
          throw new Error(`GitHub ${init.method ?? "GET"} ${url}: HTTP ${response.status}\n${await response.text()}`);
        }
        return response;
      },
      catch: cause => new Error("GitHub release request failed", { cause }),
    });
  }

  function readRelease(response: Response) {
    return Effect.tryPromise({
      try: async () => Schema.decodeUnknownSync(Release)(await response.json()),
      catch: cause => new Error("Invalid GitHub release response", { cause }),
    });
  }

  return Effect.gen(function* () {
    const { bytes, metadataBytes, manifest } = yield* fetchPackage(fetcher);
    const tag = `llt-${manifest.version}-${manifest.sha256}`;
    let release: typeof Release.Type | undefined;
    // The list endpoint includes drafts for writers. Tag lookup only promises
    // published releases, so it cannot provide draft-upload recovery.
    for (let page = 1; ; page++) {
      const response = yield* request(`${api}?per_page=100&page=${page}`);
      const releases = yield* Effect.tryPromise({
        try: async () => Schema.decodeUnknownSync(Schema.Array(Release))(await response.json()),
        catch: cause => new Error("Invalid GitHub releases response", { cause }),
      });
      release = releases.find(candidate => candidate.tag_name === tag);
      if (release || releases.length < 100) break;
    }
    if (release && !release.draft) {
      return { status: "unchanged" as const, tag, url: release.html_url };
    }

    if (!release) {
      const response = yield* request(api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: commit,
          name: `Lulutong ${manifest.version} · ${manifest.sha256.slice(0, 12)}`,
          draft: true,
          body: [
            `Publisher version: ${manifest.version}`,
            `SHA-256: \`${manifest.sha256}\``,
            "",
            "Original offline data package, publisher metadata, and acquisition manifest.",
          ].join("\n"),
        }),
      });
      release = yield* readRelease(response);
    }

    const artifacts = [
      { name: "an.db", type: "application/octet-stream", body: Buffer.from(bytes) },
      { name: "android.ver", type: "application/octet-stream", body: Buffer.from(metadataBytes) },
      {
        name: "manifest.json",
        type: "application/json",
        body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      },
    ];
    for (const artifact of artifacts) {
      // Drafts can remain after an interrupted upload. Replace their assets as
      // one acquisition snapshot before making the release visible.
      const previous = release.assets.find(asset => asset.name === artifact.name);
      if (previous) yield* request(`${api}/assets/${previous.id}`, { method: "DELETE" });
      yield* request(
        `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(artifact.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": artifact.type },
          body: artifact.body,
        },
      );
    }
    const publishedResponse = yield* request(`${api}/${release.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: false, make_latest: "true" }),
    });
    const published = yield* readRelease(publishedResponse);
    return { status: "published" as const, tag, url: published.html_url };
  });
}

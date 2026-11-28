import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { fetchPackage } from "./package.ts";

const Release = Schema.Struct({
  id: Schema.Number,
  tag_name: Schema.String,
  html_url: Schema.String,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, digest: Schema.NullOr(Schema.String) })),
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

  function request(url: string, { allowNotFound, ...init }: RequestInit & { allowNotFound?: boolean } = {}) {
    return Effect.tryPromise({
      try: async signal => {
        const response = await fetcher(url, {
          ...init,
          headers: { ...headers, ...init.headers },
          signal,
        });
        if (!response.ok && !(allowNotFound && response.status === 404)) {
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
    const latestResponse = yield* request(`${api}/latest`, { allowNotFound: true });
    if (latestResponse.ok) {
      const latest = yield* readRelease(latestResponse);
      const digest = latest.assets.find(asset => asset.name === "an.db")?.digest;
      if (digest === `sha256:${manifest.sha256}`) {
        return { status: "unchanged" as const, tag: latest.tag_name, url: latest.html_url };
      }
    }

    const tag = `llt-${manifest.version}-${manifest.sha256}-${randomUUID()}`;
    const draftResponse = yield* request(api, {
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
    const draft = yield* readRelease(draftResponse);

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
      yield* request(
        `https://uploads.github.com/repos/${repository}/releases/${draft.id}/assets?name=${encodeURIComponent(artifact.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": artifact.type },
          body: artifact.body,
        },
      );
    }
    const publishedResponse = yield* request(`${api}/${draft.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: false, make_latest: "true" }),
    });
    const published = yield* readRelease(publishedResponse);
    return { status: "published" as const, tag, url: published.html_url };
  });
}

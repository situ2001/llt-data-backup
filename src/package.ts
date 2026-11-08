import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { strFromU8, unzipSync } from "fflate";

export const VERSION_URL = "http://down.lltskb.com/android.ver";

const Version = Schema.Struct({ data: Schema.String });
const Mirrors = Schema.Array(Schema.String);
const requiredMembers = [
  "ver.txt", "s.i", "t.i", "t.rule", "routes.dat", "extra.dat", "jlb.dat",
  "sp.dat", "xw.dat", "sn.dat",
  ...Array.from({ length: 10 }, (_, index) => `S${index}.dat`),
  ...Array.from({ length: 20 }, (_, index) => `T${index}.dat`),
];

// The publisher's unrelated market section contains malformed JSON. Read only
// the top-level members that describe the offline data package.
function topLevelMember(source: string, key: string): unknown {
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      const start = index++;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === '"') break;
        else index++;
      }
      if (depth !== 1 || JSON.parse(source.slice(start, index + 1)) !== key) continue;
      let valueStart = index + 1;
      while (/\s/.test(source[valueStart] ?? "")) valueStart++;
      if (source[valueStart++] !== ":") continue;
      while (/\s/.test(source[valueStart] ?? "")) valueStart++;
      const opener = source[valueStart];
      const closer = opener === "{" ? "}" : opener === "[" ? "]" : undefined;
      if (!closer) throw new Error(`Invalid ${key} value`);
      let nesting = 0;
      let quoted = false;
      for (let end = valueStart; end < source.length; end++) {
        const token = source[end];
        if (quoted) {
          if (token === "\\") end++;
          else if (token === '"') quoted = false;
        } else if (token === '"') quoted = true;
        else if (token === opener) nesting++;
        else if (token === closer && --nesting === 0) {
          return JSON.parse(source.slice(valueStart, end + 1));
        }
      }
      throw new Error(`Unterminated ${key} value`);
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
  throw new Error(`Missing ${key} field`);
}

export function parseVersionDocument(source: string) {
  const version = Schema.decodeUnknownSync(Version)(topLevelMember(source, "version")).data;
  const mirrors = Schema.decodeUnknownSync(Mirrors)(topLevelMember(source, "dataUrl"));
  if (!/^\d{8}$/.test(version) || mirrors.length === 0) {
    throw new Error("Invalid data version or empty mirror list");
  }
  for (const mirror of mirrors) {
    const url = new URL(mirror);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Unsupported package URL: ${mirror}`);
    }
  }
  return { version, mirrors };
}

export function validatePackage(bytes: Uint8Array, version: string) {
  const members = unzipSync(bytes);
  for (const name of requiredMembers) {
    if (!members[name]?.byteLength) throw new Error(`Missing or empty package member: ${name}`);
  }
  if (strFromU8(members["ver.txt"]!).trim() !== version) {
    throw new Error(`Package ver.txt does not match ${version}`);
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export function fetchPackage(fetcher: typeof fetch = fetch) {
  return Effect.gen(function* () {
    const metadata = yield* Effect.tryPromise({
      try: async signal => {
        const response = await fetcher(VERSION_URL, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${VERSION_URL}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { bytes, ...parseVersionDocument(new TextDecoder().decode(bytes)) };
      },
      catch: cause => new Error("Unable to read Lulutong version metadata", { cause }),
    });
    const errors: Error[] = [];
    for (const sourceUrl of metadata.mirrors) {
      const result = yield* Effect.result(Effect.tryPromise({
        try: async signal => {
          const response = await fetcher(sourceUrl, { signal });
          if (!response.ok) throw new Error(`HTTP ${response.status} from ${sourceUrl}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          const sha256 = validatePackage(bytes, metadata.version);
          return {
            bytes,
            metadataBytes: metadata.bytes,
            manifest: {
              version: metadata.version,
              sha256,
              sourceUrl,
              metadataUrl: VERSION_URL,
              retrievedAt: new Date().toISOString(),
              bytes: bytes.byteLength,
            },
          };
        },
        catch: cause => new Error(`Unable to use package mirror ${sourceUrl}`, { cause }),
      }));
      if (result._tag === "Success") return result.success;
      errors.push(result.failure);
    }
    return yield* Effect.fail(new AggregateError(errors, "No valid Lulutong package mirror"));
  });
}

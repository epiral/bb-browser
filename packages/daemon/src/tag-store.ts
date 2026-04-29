import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DAEMON_DIR, type TagRecord } from "@bb-browser/shared";

interface TagStoreFile {
  version: 1;
  domains: Record<string, Record<string, TagRecord>>;
}

const TAGS_JSON = path.join(DAEMON_DIR, "tags.json");

function emptyStore(): TagStoreFile {
  return { version: 1, domains: {} };
}

function readStore(): TagStoreFile {
  try {
    const raw = readFileSync(TAGS_JSON, "utf8");
    const parsed = JSON.parse(raw) as Partial<TagStoreFile>;
    if (parsed.version === 1 && parsed.domains && typeof parsed.domains === "object") {
      return {
        version: 1,
        domains: parsed.domains as Record<string, Record<string, TagRecord>>,
      };
    }
  } catch {}
  return emptyStore();
}

function writeStore(store: TagStoreFile): void {
  mkdirSync(DAEMON_DIR, { recursive: true });
  writeFileSync(TAGS_JSON, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function ensureDomainMap(
  store: TagStoreFile,
  domain: string,
): Record<string, TagRecord> {
  store.domains[domain] ??= {};
  return store.domains[domain];
}

export function listTags(domain: string): TagRecord[] {
  const store = readStore();
  return Object.values(store.domains[domain] ?? {}).sort((a, b) => a.name.localeCompare(b.name));
}

export function getTag(domain: string, name: string): TagRecord | null {
  const store = readStore();
  return store.domains[domain]?.[name] ?? null;
}

export function setTag(record: TagRecord): TagRecord {
  const store = readStore();
  const domainMap = ensureDomainMap(store, record.domain);
  domainMap[record.name] = record;
  writeStore(store);
  return record;
}

export function removeTag(domain: string, name: string): boolean {
  const store = readStore();
  const domainMap = store.domains[domain];
  if (!domainMap?.[name]) {
    return false;
  }
  delete domainMap[name];
  if (Object.keys(domainMap).length === 0) {
    delete store.domains[domain];
  }
  writeStore(store);
  return true;
}

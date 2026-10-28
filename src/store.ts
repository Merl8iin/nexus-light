// The one shared Durable Object: memories and files in its SQLite storage.
// MCP sessions each get their own McpAgent instance, so anything that must outlive a session lives here.
import { DurableObject } from "cloudflare:workers";
import { zipSync, strToU8 } from "fflate";
import { docStub } from "./region";
import { fileName } from "./web";
import { uploadFile, credsFromEnv, BACKUP_FOLDER, type Creds } from "./bycs";

const MAX_FILE = 2 * 1024 * 1024 - 1024; // a SQLite row tops out at 2 MB

export class Store extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', created TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, data BLOB NOT NULL, size INTEGER NOT NULL, mtime TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }

  getMeta(key: string) {
    return (this.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0]?.value as string | undefined) ?? null;
  }

  setMeta(key: string, value: string) {
    this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
  }

  /** Everything as one .zip: each document as .docx, memories and text files. Entries are stored, not deflated. */
  async buildBackup() {
    const files: Record<string, [Uint8Array, { level: 0 }]> = {};
    const docs = this.docList();
    const used = new Set<string>();
    for (const d of docs) {
      let name = fileName(d.title);
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${fileName(d.title)} (${i})`;
      used.add(name.toLowerCase());
      files[`Dokumente/${name}.docx`] = [await docStub(this.env, d.id).exportDocx(d.title), { level: 0 }];
    }
    const memories = this.memorySearch("", 100000);
    files["Memory.md"] = [strToU8(memories.map((m) => `- [${m.created.slice(0, 10)}]${m.tags ? ` (${m.tags})` : ""} ${m.text}`).join("\n") || "(leer)"), { level: 0 }];
    for (const f of this.fileList()) { const data = this.fileGet(f.name); if (data) files[`Dateien/${fileName(f.name)}`] = [data, { level: 0 }]; }
    files["index.json"] = [strToU8(JSON.stringify({ exported: new Date().toISOString(), docs }, null, 2)), { level: 0 }];
    return { name: `nexus-light-backup-${new Date().toISOString().slice(0, 10)}.zip`, data: zipSync(files) };
  }

  /** Upload a backup into the ByCS-Drive folder and count it as the latest backup. */
  async backupToBycs() {
    const creds = await this.bycsCreds();
    if (!creds) throw new Error("ByCS ist noch nicht verbunden (Einstellungen → ByCS verbinden).");
    const { name, data } = await this.buildBackup();
    const where = await uploadFile(creds, BACKUP_FOLDER, name, data, "application/zip");
    this.setMeta("lastBackup", new Date().toISOString());
    this.setMeta("lastBycsBackup", new Date().toISOString());
    return `${where} (${Math.ceil(data.byteLength / 1024)} KB)`;
  }

  // ---- ByCS login, stored AES-GCM encrypted with a key derived from the owner password ----
  private async bycsKey() {
    const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${this.env.OWNER_PASSWORD}:nexus-light-bycs`));
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  async bycsSave(c: Creds) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.bycsKey(), new TextEncoder().encode(JSON.stringify(c))));
    const blob = new Uint8Array(iv.length + ct.length); blob.set(iv); blob.set(ct, iv.length);
    this.setMeta("bycs", btoa(String.fromCharCode(...blob)));
  }

  bycsClear() { this.sql.exec(`DELETE FROM meta WHERE key = 'bycs'`); }

  /** The ByCS login: BYCS_* secrets win, else the one saved on the settings page (null if none or unreadable). */
  async bycsCreds(): Promise<Creds | null> {
    const fromEnv = credsFromEnv(this.env);
    if (fromEnv) return fromEnv;
    const b64 = this.getMeta("bycs");
    if (!b64) return null;
    try {
      const blob = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12) }, await this.bycsKey(), blob.slice(12));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch { return null; } // owner password changed: the user has to connect again
  }

  /** What the settings page shows: where the login comes from and for whom (never the password). */
  async bycsStatus() {
    const c = await this.bycsCreds();
    return c ? { source: credsFromEnv(this.env) ? "secrets" : "settings", school: c.school, user: c.user, lastBackup: this.getMeta("lastBycsBackup") } : null;
  }

  /** A random id for this installation (sent with feedback instead of anything identifying). */
  instanceId() {
    let id = this.getMeta("instanceId");
    if (!id) { id = crypto.randomUUID(); this.setMeta("instanceId", id); }
    return id;
  }

  /** Days since the owner last downloaded a backup, or null if there is nothing worth backing up yet. */
  backupAge() {
    const docs = this.sql.exec(`SELECT count(*) AS n, min(created) AS first FROM docs`).one();
    if (!(docs.n as number)) return null;
    const since = this.getMeta("lastBackup") ?? (docs.first as string);
    return { days: Math.floor((Date.now() - Date.parse(since)) / 86400000), ever: !!this.getMeta("lastBackup") };
  }

  // ---- live documents (content lives in each DocRoom; this is the index) ----
  docCreate(title: string) {
    const id = crypto.randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    this.sql.exec(`INSERT INTO docs (id, title, created, updated) VALUES (?, ?, ?, ?)`, id, title, now, now);
    return { id, title };
  }

  docList() {
    return this.sql.exec(`SELECT id, title, updated FROM docs ORDER BY updated DESC`).toArray() as { id: string; title: string; updated: string }[];
  }

  /** Find a document by id, or by title (exact, then case-insensitive prefix). */
  docFind(ref: string) {
    const r = this.sql.exec(`SELECT id, title FROM docs WHERE id = ? OR title = ? LIMIT 1`, ref, ref).toArray()[0]
      ?? this.sql.exec(`SELECT id, title FROM docs WHERE lower(title) LIKE ? ORDER BY updated DESC LIMIT 1`, ref.toLowerCase() + "%").toArray()[0];
    return (r as { id: string; title: string } | undefined) ?? null;
  }

  docTouch(id: string) {
    this.sql.exec(`UPDATE docs SET updated = ? WHERE id = ?`, new Date().toISOString(), id);
  }

  docRename(id: string, title: string) {
    return this.sql.exec(`UPDATE docs SET title = ? WHERE id = ?`, title, id).rowsWritten > 0;
  }

  docDelete(id: string) {
    return this.sql.exec(`DELETE FROM docs WHERE id = ?`, id).rowsWritten > 0;
  }

  stats() {
    const m = this.sql.exec(`SELECT count(*) AS n FROM memory`).one().n as number;
    const f = this.sql.exec(`SELECT count(*) AS n, coalesce(sum(size),0) AS b FROM files`).one();
    return { memories: m, files: f.n as number, bytes: f.b as number };
  }

  memorySave(text: string, tags: string[]) {
    return this.sql.exec(`INSERT INTO memory (text, tags, created) VALUES (?, ?, ?) RETURNING id`, text, tags.join(", "), new Date().toISOString()).one().id as number;
  }

  memorySearch(query: string, limit: number) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const where = words.map(() => `lower(text || ' ' || tags) LIKE ?`).join(" AND ") || "1";
    return this.sql.exec(`SELECT id, text, tags, created FROM memory WHERE ${where} ORDER BY id DESC LIMIT ?`, ...words.map((w) => `%${w}%`), limit)
      .toArray() as { id: number; text: string; tags: string; created: string }[];
  }

  memoryDelete(id: number) {
    return this.sql.exec(`DELETE FROM memory WHERE id = ?`, id).rowsWritten > 0;
  }

  fileList() {
    return this.sql.exec(`SELECT name, size, mtime FROM files ORDER BY mtime DESC`).toArray() as { name: string; size: number; mtime: string }[];
  }

  fileGet(name: string) {
    const r = this.sql.exec(`SELECT data FROM files WHERE name = ?`, name).toArray()[0];
    return r ? new Uint8Array(r.data as ArrayBuffer) : null;
  }

  filePut(name: string, data: Uint8Array) {
    if (data.byteLength > MAX_FILE) throw new Error(`File too large (${data.byteLength} B, max ${MAX_FILE})`);
    this.sql.exec(`INSERT INTO files (name, data, size, mtime) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data, size = excluded.size, mtime = excluded.mtime`,
      name, data, data.byteLength, new Date().toISOString());
    return data.byteLength;
  }

  fileDelete(name: string) {
    return this.sql.exec(`DELETE FROM files WHERE name = ?`, name).rowsWritten > 0;
  }
}

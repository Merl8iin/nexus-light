// One Durable Object per document: the shared Yjs doc, the y-websocket relay for browsers,
// and the agent's edits (which arrive over RPC and show up live with the agent's own cursor).
// Uses the WebSocket hibernation API, so an idle document costs nothing.
import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { blocksFromMarkdown, blockToMarkdown, type Block } from "./markdown";
import { toDocx, type PMNode, type ImageData } from "./docx";

const MSG_SYNC = 0, MSG_AWARENESS = 1, MSG_QUERY_AWARENESS = 3;
const FRAGMENT = "prosemirror";
const COMPACT_AFTER = 200;
const MAX_IMAGE = 2 * 1024 * 1024 - 4096; // one SQLite row

type Presence = { clock: number; state: string };
type Attachment = { clients: number[] };

export class DocRoom extends DurableObject<Env> {
  sql: SqlStorage;
  doc: Y.Doc;
  /** Last awareness entry per client id, so new browsers see who is here (lost on hibernation; clients re-send every 15 s). */
  presence = new Map<number, Presence>();
  agentIds = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)`);
    // Images live beside the Yjs doc, not in it, so syncing text stays small; the doc only holds their URL.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS images (hash TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL, created TEXT NOT NULL)`);
    this.doc = new Y.Doc();
    for (const r of this.sql.exec(`SELECT data FROM updates ORDER BY id`)) Y.applyUpdate(this.doc, new Uint8Array(r.data as ArrayBuffer), "load");
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "load") return;
      this.persist(update);
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeUpdate(e, update);
      this.broadcast(encoding.toUint8Array(e), origin instanceof WebSocket ? origin : null);
    });
  }

  persist(update: Uint8Array) {
    this.sql.exec(`INSERT INTO updates (data) VALUES (?)`, update);
    const n = this.sql.exec(`SELECT count(*) AS n FROM updates`).one().n as number;
    if (n > COMPACT_AFTER) {
      const full = Y.encodeStateAsUpdate(this.doc);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`DELETE FROM updates`);
        this.sql.exec(`INSERT INTO updates (data) VALUES (?)`, full);
      });
    }
  }

  broadcast(msg: Uint8Array, except: WebSocket | null = null) {
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) { try { ws.send(msg); } catch {} }
  }

  // ---------- browsers (y-websocket protocol) ----------
  async fetch(req: Request) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ clients: [] } satisfies Attachment);
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeSyncStep1(e, this.doc);
    server.send(encoding.toUint8Array(e));
    if (this.presence.size) server.send(this.awarenessMessage([...this.presence.keys()]));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message === "string") return;
    const d = decoding.createDecoder(new Uint8Array(message));
    const type = decoding.readVarUint(d);
    if (type === MSG_SYNC) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.readSyncMessage(d, e, this.doc, ws);
      if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
    } else if (type === MSG_AWARENESS) {
      const update = decoding.readVarUint8Array(d);
      const ids = this.applyPresence(update);
      const att = ws.deserializeAttachment() as Attachment;
      const known = new Set(att.clients);
      if (ids.some((id) => !known.has(id))) ws.serializeAttachment({ clients: [...new Set([...att.clients, ...ids])] });
      // To everyone, the sender too: y-websocket treats 30 s without any message as a dead connection.
      this.broadcast(new Uint8Array(message));
    } else if (type === MSG_QUERY_AWARENESS) {
      if (this.presence.size) ws.send(this.awarenessMessage([...this.presence.keys()]));
    }
  }

  async webSocketClose(ws: WebSocket) { this.dropClient(ws); }
  async webSocketError(ws: WebSocket) { this.dropClient(ws); }

  dropClient(ws: WebSocket) {
    const { clients } = (ws.deserializeAttachment() as Attachment) ?? { clients: [] };
    if (!clients.length) return;
    for (const id of clients) this.presence.set(id, { clock: (this.presence.get(id)?.clock ?? 0) + 1, state: "null" });
    this.broadcast(this.awarenessMessage(clients), ws);
    for (const id of clients) this.presence.delete(id);
  }

  /** Decode an awareness update (count, then clientID, clock, JSON state) into the presence map. */
  applyPresence(update: Uint8Array) {
    const d = decoding.createDecoder(update);
    const ids: number[] = [];
    for (let n = decoding.readVarUint(d); n > 0; n--) {
      const id = decoding.readVarUint(d), clock = decoding.readVarUint(d), state = decoding.readVarString(d);
      ids.push(id);
      if (state === "null") this.presence.delete(id);
      else this.presence.set(id, { clock, state });
    }
    return ids;
  }

  awarenessMessage(ids: number[]) {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_AWARENESS);
    const u = encoding.createEncoder();
    const present = ids.filter((id) => this.presence.has(id));
    encoding.writeVarUint(u, present.length);
    for (const id of present) {
      const p = this.presence.get(id)!;
      encoding.writeVarUint(u, id);
      encoding.writeVarUint(u, p.clock);
      encoding.writeVarString(u, p.state);
    }
    encoding.writeVarUint8Array(e, encoding.toUint8Array(u));
    return encoding.toUint8Array(e);
  }

  // ---------- the agent ----------
  /** Show the agent's cursor (with name label) at a text position; browsers drop it after 30 s without updates. */
  agentCursor(agent: { name: string; color: string }, at: { text: Y.XmlText; index: number } | null) {
    let id = this.agentIds.get(agent.name);
    if (id == null) { id = 0x40000000 + (hash(agent.name) % 0x3fffffff); this.agentIds.set(agent.name, id); }
    const state: Record<string, unknown> = { user: { name: agent.name, color: agent.color, agent: true } };
    if (at) {
      // Stick to the character before the cursor (assoc -1); "end of the text" otherwise resolves to its start.
      const rel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(at.text, at.index, at.index > 0 ? -1 : 0));
      state.cursor = { anchor: rel, head: rel };
    }
    this.presence.set(id, { clock: (this.presence.get(id)?.clock ?? 0) + 1, state: JSON.stringify(state) });
    this.broadcast(this.awarenessMessage([id]));
  }

  get fragment() { return this.doc.getXmlFragment(FRAGMENT); }

  /** The document as numbered markdown blocks, for the agent to address by index. */
  read() {
    const blocks = this.fragment.toArray();
    if (!blocks.length) return "(leeres Dokument)";
    return blocks.map((b, i) => `[${i}] ${blockToMarkdown(b as Y.XmlElement)}`).join("\n");
  }

  markdown() {
    return this.fragment.toArray().map((b) => blockToMarkdown(b as Y.XmlElement)).join("\n\n");
  }

  /** Insert markdown blocks at index (default: end). With animate, text appears in small steps, like typing. */
  async insert(agent: { name: string; color: string }, md: string, index: number | undefined, animate: boolean) {
    const frag = this.fragment;
    let pos = index == null || index < 0 || index > frag.length ? frag.length : index;
    const blocks = blocksFromMarkdown(md);
    const total = blocks.reduce((n, b) => n + b.text.reduce((m, r) => m + r.text.length, 0), 0);
    const typing = animate && total <= 1500;
    for (const b of blocks) {
      if (!typing) {
        const el = buildBlock(b);
        this.doc.transact(() => frag.insert(pos, [el]), "agent");
        this.agentCursor(agent, lastText(el));
        pos++;
        if (animate) await sleep(120);
        continue;
      }
      // Typing: create the block empty, then stream its runs in word-sized chunks.
      const el = buildBlock({ ...b, text: [] });
      this.doc.transact(() => frag.insert(pos, [el]), "agent");
      const text = lastText(el)!.text;
      for (const run of b.text) {
        for (const chunk of run.text.match(/\S+\s*|\s+/g) ?? []) {
          this.doc.transact(() => text.insert(text.length, chunk, run.marks), "agent");
          this.agentCursor(agent, { text, index: text.length });
          await sleep(45);
        }
      }
      pos++;
    }
    return `${blocks.length} Block/Blöcke eingefügt`;
  }

  /** Replace whole blocks (by index) with new markdown. */
  async replaceBlocks(agent: { name: string; color: string }, index: number, count: number, md: string) {
    const frag = this.fragment;
    if (index < 0 || index >= frag.length) throw new Error(`Kein Block [${index}]`);
    const old = frag.get(index) as Y.XmlElement;
    const first = lastText(old);
    if (first) { this.agentCursor(agent, { text: first.text, index: 0 }); await sleep(400); }
    const els = blocksFromMarkdown(md).map(buildBlock);
    this.doc.transact(() => { frag.delete(index, Math.min(count, frag.length - index)); frag.insert(index, els); }, "agent");
    const last = els.length ? lastText(els[els.length - 1]) : null;
    this.agentCursor(agent, last);
    return `Block [${index}] ersetzt`;
  }

  async deleteBlocks(agent: { name: string; color: string }, indices: number[]) {
    const frag = this.fragment;
    const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < frag.length).sort((a, b) => b - a);
    this.doc.transact(() => { for (const i of sorted) frag.delete(i, 1); }, "agent");
    const near = frag.get(Math.min(sorted.at(-1) ?? 0, frag.length - 1)) as Y.XmlElement | undefined;
    this.agentCursor(agent, near ? lastText(near) : null);
    return `${sorted.length} Block/Blöcke gelöscht`;
  }

  /** Find and replace inside text runs, keeping the formatting of the replaced text. */
  async replaceText(agent: { name: string; color: string }, search: string, replace: string, all: boolean) {
    let count = 0;
    for (const text of allTexts(this.fragment)) {
      for (let from = 0; ; ) {
        const at = deltaText(text).indexOf(search, from);
        if (at < 0) break;
        from = at + replace.length;
        const attrs = attrsAt(text, at);
        this.agentCursor(agent, { text, index: at });
        await sleep(250);
        this.doc.transact(() => { text.delete(at, search.length); text.insert(at, replace, attrs); }, "agent");
        this.agentCursor(agent, { text, index: at + replace.length });
        count++;
        if (!all) return `1 Stelle ersetzt`;
      }
    }
    return `${count} Stelle(n) ersetzt`;
  }

  // ---------- comments (threads in the Yjs map "comments", anchored by a `comment` text attribute) ----------
  get threads() { return this.doc.getMap("comments") as Y.Map<any>; }

  /** Comment on the nth occurrence of `search`; the cursor jumps there first so people see what is meant. */
  async comment(agent: { name: string; color: string }, search: string, text: string, nth = 0) {
    let seen = 0;
    for (const t of allTexts(this.fragment)) {
      for (let from = 0, at; (at = deltaText(t).indexOf(search, from)) >= 0; from = at + 1) {
        if (seen++ < nth) continue;
        this.agentCursor(agent, { text: t, index: at });
        await sleep(300);
        const id = Math.random().toString(36).slice(2, 10);
        this.doc.transact(() => {
          this.threads.set(id, { id, author: agent.name, color: agent.color, agent: true, text, created: new Date().toISOString(), replies: [] });
          t.format(at, search.length, { comment: { id } });
        }, "agent");
        this.agentCursor(agent, { text: t, index: at + search.length });
        return `Kommentar ${id} gesetzt`;
      }
    }
    throw new Error(`Text nicht gefunden: ${search}`);
  }

  /** All threads with the text they are anchored on, in document order. */
  comments(includeResolved: boolean) {
    const quotes = new Map<string, string>();
    for (const t of allTexts(this.fragment)) for (const d of t.toDelta() as { insert: unknown; attributes?: Record<string, any> }[]) {
      if (typeof d.insert !== "string") continue;
      for (const [k, v] of Object.entries(d.attributes ?? {})) if (k.startsWith("comment") && v?.id) quotes.set(v.id, (quotes.get(v.id) ?? "") + d.insert);
    }
    const out: string[] = [];
    for (const [id, quote] of quotes) {
      const t = this.threads.get(id);
      if (!t || (t.resolved && !includeResolved)) continue;
      out.push(`[${id}]${t.resolved ? " (erledigt)" : ""} zu „${quote.slice(0, 100)}“\n  ${t.author}: ${t.text}` + (t.replies as any[]).map((r) => `\n  ↳ ${r.author}: ${r.text}`).join(""));
    }
    return out.join("\n\n") || "Keine offenen Kommentare.";
  }

  replyComment(agent: { name: string; color: string }, id: string, text: string) {
    const t = this.threads.get(id);
    if (!t) throw new Error(`Kein Kommentar ${id}`);
    this.threads.set(id, { ...t, replies: [...t.replies, { author: agent.name, color: agent.color, agent: true, text, created: new Date().toISOString() }] });
    return `Antwort auf ${id} gespeichert`;
  }

  resolveComment(id: string, resolved: boolean) {
    const t = this.threads.get(id);
    if (!t) throw new Error(`Kein Kommentar ${id}`);
    this.threads.set(id, { ...t, resolved });
    return resolved ? `${id} erledigt` : `${id} wieder geöffnet`;
  }

  /** Point the agent's cursor somewhere without editing (e.g. "I'm looking at this"). */
  async point(agent: { name: string; color: string }, search: string) {
    for (const text of allTexts(this.fragment)) {
      const at = deltaText(text).indexOf(search);
      if (at >= 0) { this.agentCursor(agent, { text, index: at }); return `Cursor bei "${search}"`; }
    }
    throw new Error(`Text nicht gefunden: ${search}`);
  }

  // ---------- images ----------
  /** Store an image (already shrunk by the browser); same bytes, same hash, stored once. */
  async putImage(data: ArrayBuffer, type: string) {
    if (data.byteLength > MAX_IMAGE) throw new Error(`Bild zu groß (${Math.ceil(data.byteLength / 1024)} KB, max. ${MAX_IMAGE / 1024} KB)`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    const hash = [...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.sql.exec(`INSERT OR IGNORE INTO images (hash, type, data, created) VALUES (?, ?, ?, ?)`, hash, type, data, new Date().toISOString());
    return hash;
  }

  getImage(hash: string) {
    const r = this.sql.exec(`SELECT type, data FROM images WHERE hash = ?`, hash).toArray()[0];
    return r ? { type: r.type as string, data: r.data as ArrayBuffer } : null;
  }

  /** The document as .docx, with its stored images embedded. */
  exportDocx(title: string) {
    const json = yToJson(this.fragment);
    const images = new Map<string, ImageData>();
    const walk = (n: PMNode) => {
      const m = n.type === "image" && String(n.attrs?.src ?? "").match(/\/img\/([0-9a-f]{24})$/);
      if (m && !images.has(n.attrs!.src)) { const img = this.getImage(m[1]); if (img) images.set(n.attrs!.src, { data: new Uint8Array(img.data), type: img.type }); }
      n.content?.forEach(walk);
    };
    walk(json);
    return toDocx(title, json, images);
  }

  async destroy() {
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "deleted");
    await this.ctx.storage.deleteAll();
  }
}

/** The Yjs fragment as ProseMirror-shaped JSON (same shape y-prosemirror produces). */
function yToJson(node: Y.XmlFragment | Y.XmlElement): PMNode {
  const content: PMNode[] = [];
  for (const c of node.toArray()) {
    if (c instanceof Y.XmlText) {
      for (const d of c.toDelta() as { insert: unknown; attributes?: Record<string, any> }[]) {
        if (typeof d.insert !== "string" || !d.insert) continue;
        content.push({ type: "text", text: d.insert, marks: Object.entries(d.attributes ?? {}).map(([type, attrs]) => ({ type, attrs: attrs ?? {} })) });
      }
    } else if (c instanceof Y.XmlElement) content.push(yToJson(c));
  }
  return node instanceof Y.XmlElement ? { type: node.nodeName, attrs: node.getAttributes() as Record<string, any>, content } : { type: "doc", content };
}

// ---------- Y.Xml helpers (node names follow prosemirror-schema-basic + schema-list) ----------
function buildBlock(b: Block): Y.XmlElement {
  if (b.type === "bullet_list" || b.type === "ordered_list") {
    const list = new Y.XmlElement(b.type);
    if (b.type === "ordered_list") list.setAttribute("order", 1 as any);
    list.insert(0, b.items!.map((item) => {
      const li = new Y.XmlElement("list_item");
      li.insert(0, [buildBlock({ type: "paragraph", text: item })]);
      return li;
    }));
    return list;
  }
  if (b.type === "blockquote") {
    const q = new Y.XmlElement("blockquote");
    q.insert(0, [buildBlock({ type: "paragraph", text: b.text })]);
    return q;
  }
  if (b.type === "horizontal_rule") return new Y.XmlElement("horizontal_rule");
  if (b.type === "image") {
    const img = new Y.XmlElement("image");
    img.setAttribute("src", b.src!);
    img.setAttribute("alt", b.alt ?? "");
    return img;
  }
  if (b.type === "table") {
    const table = new Y.XmlElement("table");
    const width = Math.max(...b.rows!.map((r) => r.length));
    table.insert(0, b.rows!.map((cells, r) => {
      const row = new Y.XmlElement("table_row");
      row.insert(0, Array.from({ length: width }, (_, c) => {
        const cell = new Y.XmlElement(r === 0 ? "table_header" : "table_cell");
        cell.setAttribute("colspan", 1 as any);
        cell.setAttribute("rowspan", 1 as any);
        cell.insert(0, [buildBlock({ type: "paragraph", text: cells[c] ?? [] })]);
        return cell;
      }));
      return row;
    }));
    return table;
  }
  const el = new Y.XmlElement(b.type);
  if (b.type === "heading") el.setAttribute("level", b.level as any);
  const t = new Y.XmlText();
  let i = 0;
  for (const r of b.text) { t.insert(i, r.text, r.marks); i += r.text.length; }
  el.insert(0, [t]);
  return el;
}

function lastText(el: Y.XmlElement): { text: Y.XmlText; index: number } | null {
  const ts = allTexts(el);
  const t = ts[ts.length - 1];
  return t ? { text: t, index: t.length } : null;
}

function allTexts(node: Y.XmlElement | Y.XmlFragment): Y.XmlText[] {
  const out: Y.XmlText[] = [];
  for (const c of node.toArray()) {
    if (c instanceof Y.XmlText) out.push(c);
    else if (c instanceof Y.XmlElement) out.push(...allTexts(c));
  }
  return out;
}

const deltaText = (t: Y.XmlText) => (t.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === "string" ? d.insert : "￼")).join("");

function attrsAt(t: Y.XmlText, index: number) {
  let i = 0;
  for (const d of t.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    const len = typeof d.insert === "string" ? d.insert.length : 1;
    if (index < i + len) return d.attributes ?? {};
    i += len;
  }
  return {};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function hash(s: string) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; }

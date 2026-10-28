// Nexus Light: a self-hostable MCP gateway on Cloudflare's free tier.
// /mcp is the MCP endpoint (OAuth, so claude.ai and ChatGPT can add it as a connector).
// /authorize is the owner's sign-in + consent page. Shared state lives in the Store Durable Object.
import OAuthProvider, { type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Store } from "./store";
import { DocRoom } from "./doc";
import { handleWeb, shareKey } from "./web";
import { storeStub, docStub, region } from "./region";
import { spaces, listFolder, moodle, moodleMe, BACKUP_FOLDER } from "./bycs";

export { Store, DocRoom };

type Props = { user: string; origin?: string };
const VERSION = "0.4.0";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const store = storeStub;

// How each AI client appears in documents: its cursor's name and color.
const AGENTS: [RegExp, string, string][] = [
  [/claude-code/i, "Claude Code", "#d97757"],
  [/claude|anthropic/i, "Claude", "#d97757"],
  [/openai|chatgpt/i, "ChatGPT", "#10a37f"],
  [/cursor/i, "Cursor", "#6b7280"],
  [/gemini|google/i, "Gemini", "#4285f4"],
  [/mistral|le ?chat/i, "Le Chat", "#fa520f"],
];

export class NexusMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: "Nexus Light", version: VERSION }, {
    // Read by the AI client, not shown to people.
    instructions: "Nexus Light is the user's own, self-hosted workspace: live documents they can open in the browser and watch you edit (your cursor shows your name), plus memory and files. "
      + "Everything lives only in the user's own Cloudflare account, so backups are their responsibility. When a tool result ends with a [Backup-Hinweis …] note, "
      + "mention it briefly once in this conversation (one sentence with the backup link), then don't repeat it. Write documents in the user's language.",
  });

  /** A note for the agent only, appended to some results when the last backup is getting old. */
  async backupNote() {
    const age = await store(this.env).backupAge();
    if (!age || age.days < 14) return "";
    const when = age.ever ? `Das letzte Backup ist ${age.days} Tage her.` : `Es wurde noch nie ein Backup heruntergeladen (Daten seit ${age.days} Tagen).`;
    return `\n\n[Backup-Hinweis, nur für den Agenten: ${when} Erinnere den Nutzer einmal kurz daran, ein Backup herunterzuladen: ${await this.origin()}/backup.zip (als Besitzer angemeldet).]`;
  }

  /** The connected client's name as it reported itself ("claude-ai", "openai-mcp", …). */
  clientName() {
    return this.server.server.getClientVersion()?.name ?? "agent";
  }

  /** Public origin for links: PUBLIC_URL, else the origin the owner signed in on (stored in the grant). */
  async origin() {
    return (this.env.PUBLIC_URL || this.props?.origin || "").replace(/\/$/, "");
  }

  /** The agent's identity in documents, derived from the client name. */
  agent() {
    const raw = this.clientName();
    for (const [re, name, color] of AGENTS) if (re.test(raw)) return { name, color };
    return { name: raw.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 24) || "Agent", color: "#7c3aed" };
  }

  async init() {
    const s = this.server;
    const docRef = z.string().describe("Document id or title (from doc_list)");
    const room = async (ref: string) => {
      const d = await store(this.env).docFind(ref);
      if (!d) throw new Error(`Dokument nicht gefunden: ${ref}`);
      return { ...d, room: docStub(this.env, d.id) };
    };
    const edited = async (id: string, msg: string) => { await store(this.env).docTouch(id); return text(msg); };

    // ---- live documents ----
    s.registerTool("doc_list", {
      title: "List documents",
      description: "List the live documents (id, title, last change). People can open them in the browser and watch you edit.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, async () => {
      const docs = await store(this.env).docList();
      return text((docs.length ? docs.map((d) => `${d.id}  ${d.title}  (${d.updated.slice(0, 16).replace("T", " ")})`).join("\n") : "Keine Dokumente.") + (await this.backupNote()));
    });

    s.registerTool("doc_create", {
      title: "Create document",
      description: "Create a live document, optionally with initial markdown content. Returns its link; suggest the user opens it to watch you write.",
      inputSchema: { title: z.string().min(1).max(120), markdown: z.string().optional() },
    }, async ({ title, markdown }) => {
      const d = await store(this.env).docCreate(title);
      if (markdown) await docStub(this.env, d.id).insert(this.agent(), markdown, undefined, false);
      return text(`Erstellt: ${d.title} (${d.id})\nLink: ${await this.origin()}/d/${d.id}` + (await this.backupNote()));
    });

    s.registerTool("doc_read", {
      title: "Read document",
      description: "Read a live document as numbered markdown blocks: [index] content. Use the indices with doc_replace_blocks and doc_delete_blocks; they shift after inserts and deletes, so re-read when unsure.",
      inputSchema: { doc: docRef },
      annotations: { readOnlyHint: true },
    }, async ({ doc }) => {
      const d = await room(doc);
      return text(`# ${d.title} (${d.id})\n\n${await d.room.read()}`);
    });

    s.registerTool("doc_write", {
      title: "Write into document",
      description: "Insert markdown (# headings, paragraphs, - lists, 1. lists, > quotes, | tables |, **bold**, *italic*, <u>underline</u>, ~~strike~~, ==highlight==, `code`, [links](url)) at block index, or append when index is omitted. Everyone with the document open sees it appear live at your cursor, typed out word by word unless animate=false.",
      inputSchema: { doc: docRef, markdown: z.string().min(1), index: z.number().int().optional(), animate: z.boolean().default(true) },
    }, async ({ doc, markdown, index, animate }) => {
      const d = await room(doc);
      return edited(d.id, await d.room.insert(this.agent(), markdown, index, animate));
    });

    s.registerTool("doc_replace_blocks", {
      title: "Rewrite blocks",
      description: "Replace `count` blocks starting at `index` with new markdown (rewriting a paragraph, changing a heading level, turning text into a list).",
      inputSchema: { doc: docRef, index: z.number().int(), count: z.number().int().min(1).default(1), markdown: z.string() },
    }, async ({ doc, index, count, markdown }) => {
      const d = await room(doc);
      return edited(d.id, await d.room.replaceBlocks(this.agent(), index, count, markdown));
    });

    s.registerTool("doc_replace_text", {
      title: "Find and replace",
      description: "Replace text inside the document, keeping its formatting. Your cursor jumps to each place first, so people see what changes. Best for small wording edits.",
      inputSchema: { doc: docRef, search: z.string().min(1), replace: z.string(), all: z.boolean().default(true) },
    }, async ({ doc, search, replace, all }) => {
      const d = await room(doc);
      return edited(d.id, await d.room.replaceText(this.agent(), search, replace, all));
    });

    s.registerTool("doc_delete_blocks", {
      title: "Delete blocks",
      description: "Delete blocks by index (from doc_read).",
      inputSchema: { doc: docRef, indices: z.array(z.number().int()).min(1) },
      annotations: { destructiveHint: true },
    }, async ({ doc, indices }) => {
      const d = await room(doc);
      return edited(d.id, await d.room.deleteBlocks(this.agent(), indices));
    });

    s.registerTool("doc_point", {
      title: "Point at text",
      description: "Move your visible cursor to a passage without editing, e.g. to show the user what you are talking about.",
      inputSchema: { doc: docRef, search: z.string().min(1) },
      annotations: { readOnlyHint: true },
    }, async ({ doc, search }) => {
      const d = await room(doc);
      return text(await d.room.point(this.agent(), search));
    });

    s.registerTool("doc_comment", {
      title: "Comment on text",
      description: "Add a comment (like a reviewer in Word) on a passage: `search` is the exact text to anchor on, `nth` picks the occurrence (0-based). Good for feedback the user should decide on instead of editing directly.",
      inputSchema: { doc: docRef, search: z.string().min(1), text: z.string().min(1), nth: z.number().int().min(0).default(0) },
    }, async ({ doc, search, text: t, nth }) => {
      const d = await room(doc);
      return edited(d.id, await d.room.comment(this.agent(), search, t, nth));
    });

    s.registerTool("doc_comments", {
      title: "Read comments",
      description: "List the comment threads (id, anchored text, author, replies), e.g. to answer or apply what people commented.",
      inputSchema: { doc: docRef, includeResolved: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    }, async ({ doc, includeResolved }) => {
      const d = await room(doc);
      return text(await d.room.comments(includeResolved));
    });

    s.registerTool("doc_comment_reply", {
      title: "Reply to or resolve a comment",
      description: "Reply in a comment thread (text) and/or mark it resolved (resolved=true) or reopen it (false). Ids come from doc_comments.",
      inputSchema: { doc: docRef, id: z.string(), text: z.string().optional(), resolved: z.boolean().optional() },
    }, async ({ doc, id, text: t, resolved }) => {
      const d = await room(doc);
      const out: string[] = [];
      if (t) out.push(await d.room.replyComment(this.agent(), id, t));
      if (resolved != null) out.push(await d.room.resolveComment(id, resolved));
      return edited(d.id, out.join("\n") || "Nichts zu tun (text oder resolved angeben).");
    });

    s.registerTool("doc_link", {
      title: "Document links",
      description: "Get the document's link for the owner, and a share link that lets someone else (e.g. a classmate) open and edit it without a password.",
      inputSchema: { doc: docRef },
      annotations: { readOnlyHint: true },
    }, async ({ doc }) => {
      const d = await room(doc);
      const o = await this.origin();
      return text(`Öffnen: ${o}/d/${d.id}\nTeilen (ohne Passwort, zum Bearbeiten): ${o}/d/${d.id}?k=${await shareKey(this.env, d.id)}`);
    });

    s.registerTool("doc_export", {
      title: "Export document",
      description: "Export a document: format \"markdown\" returns the content; \"docx\" returns a download link for a Word file (with images) to give the user.",
      inputSchema: { doc: docRef, format: z.enum(["markdown", "docx"]).default("markdown") },
      annotations: { readOnlyHint: true },
    }, async ({ doc, format }) => {
      const d = await room(doc);
      if (format === "docx") return text(`Word-Datei: ${await this.origin()}/d/${d.id}/export.docx?k=${await shareKey(this.env, d.id)}`);
      return text(`# ${d.title}\n\n${await d.room.markdown()}`);
    });

    s.registerTool("doc_rename", {
      title: "Rename document",
      description: "Change a document's title.",
      inputSchema: { doc: docRef, title: z.string().min(1).max(120) },
    }, async ({ doc, title }) => {
      const d = await room(doc);
      await store(this.env).docRename(d.id, title);
      return text(`Umbenannt in: ${title}`);
    });

    s.registerTool("doc_remove", {
      title: "Delete document",
      description: "Permanently delete a document and its content. Only when the user asked for it.",
      inputSchema: { doc: docRef },
      annotations: { destructiveHint: true },
    }, async ({ doc }) => {
      const d = await room(doc);
      await d.room.destroy();
      await store(this.env).docDelete(d.id);
      return text(`Gelöscht: ${d.title}`);
    });

    s.registerTool("nexus_status", {
      title: "Nexus status",
      description: "Show the Nexus Light version, the connected client and what is stored.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, async () => {
      const st = await store(this.env).stats();
      const age = await store(this.env).backupAge();
      return text(`Nexus Light ${VERSION} on Cloudflare Workers (data region: ${this.env.DATA_REGION || "any"}, installation id: ${await store(this.env).instanceId()})\nClient: ${this.clientName()} → shown in documents as "${this.agent().name}"\nDocuments: ${(await store(this.env).docList()).length}\nMemories: ${st.memories}\nFiles: ${st.files} (${Math.ceil(st.bytes / 1024)} KB)\nLast backup: ${age ? (age.ever ? `${age.days} days ago` : "never") : "nothing to back up yet"}` + (await this.backupNote()));
    });

    // ---- feedback to the Nexus Light developer (on by default; FEEDBACK_URL="" removes the tool) ----
    const feedbackUrl = this.env.FEEDBACK_URL ?? "https://neuro-net.net/nexus-feedback";
    if (feedbackUrl) {
      s.registerTool("send_feedback", {
        title: "Send feedback to the Nexus Light developer",
        description: "Send a bug report, wish or praise about Nexus Light itself to its developer. REQUIRED before calling: show the user the exact text you will send and ask for permission; call only after they agreed in this conversation (set userConfirmed=true). Never include document contents, names, links, school data or other personal data. Privacy notice: " + feedbackUrl + "/datenschutz",
        inputSchema: {
          category: z.enum(["bug", "wunsch", "lob", "sonstiges"]),
          text: z.string().min(5).max(2000).describe("Exactly the text the user approved"),
          userConfirmed: z.literal(true).describe("true only after the user saw this exact text and agreed to send it"),
        },
        annotations: { openWorldHint: true },
      }, async ({ category, text: body }) => {
        const r = await fetch(feedbackUrl, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ instance: await store(this.env).instanceId(), version: VERSION, agent: this.agent().name, category, text: body }),
        });
        const j = await r.json<any>().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Feedback konnte nicht gesendet werden (HTTP ${r.status})`);
        return text(`Feedback gesendet. Danke! Datenschutz: ${feedbackUrl}/datenschutz`);
      });
    }

    // ---- backup ----
    s.registerTool("backup_now", {
      title: "Back up everything",
      description: `Back up all documents (.docx), memories and files. With ByCS connected, the .zip goes into the user's ByCS-Drive folder "${BACKUP_FOLDER}"; otherwise (or with target "link") you get the download link for the user.`,
      inputSchema: { target: z.enum(["auto", "bycs", "link"]).default("auto") },
    }, async ({ target }) => {
      const connected = !!(await store(this.env).bycsStatus());
      if (target === "link" || (target === "auto" && !connected)) return text(`Backup herunterladen (als Besitzer angemeldet): ${await this.origin()}/backup.zip`);
      return text(`Backup gespeichert: ${await store(this.env).backupToBycs()}`);
    });

    // ---- ByCS: always listed, so clients never need a refresh; they explain how to connect when needed ----
    const bycs = async () => {
      const c = await store(this.env).bycsCreds();
      if (!c) throw new Error(`ByCS ist noch nicht verbunden. Der Nutzer kann es in einer Minute einrichten: ${await this.origin()}/settings (als Besitzer anmelden, Schulnummer, Benutzername und Passwort eingeben).`);
      return c;
    };

    s.registerTool("bycs_drives", {
      title: "ByCS-Drive spaces",
      description: "List the user's ByCS-Drive spaces (BayernCloud Schule: personal space, class and project spaces).",
      inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: true },
    }, async () => text((await spaces(await bycs())).map((x) => `${x.type.padEnd(9)} ${x.name}  (${x.id})`).join("\n")));

    s.registerTool("bycs_list", {
      title: "List ByCS-Drive folder",
      description: "List files and folders in a ByCS-Drive space (name or id; default: personal space) at path (default: root).",
      inputSchema: { space: z.string().optional(), path: z.string().default("/") }, annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ space, path }) => {
      const r = await listFolder(await bycs(), space, path);
      return text(r.items.length ? `${r.space}${r.path}\n` + r.items.map((i) => `${i.dir ? "📁" : "  "} ${i.name}${i.dir ? "/" : ""}  ${i.dir ? "" : `${Math.ceil(i.size / 1024)} KB  `}${i.mtime}`).join("\n") : `(leer) ${r.space}${r.path}`);
    });

    s.registerTool("moodle_courses", {
      title: "Lernplattform courses",
      description: "List the user's ByCS-Lernplattform (Moodle) courses with ids.",
      inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: true },
    }, async () => {
      const c = await bycs();
      const me = await moodleMe(c);
      const courses = await moodle(c, "core_enrol_get_users_courses", { userid: String(me.userid) });
      return text((courses as any[]).map((x) => `${String(x.id).padEnd(8)} ${x.fullname}`).join("\n"));
    });

    s.registerTool("moodle_deadlines", {
      title: "Upcoming deadlines",
      description: "Upcoming assignment due dates and other calendar events from the ByCS-Lernplattform.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(15) }, annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ limit }) => {
      const r = await moodle(await bycs(), "core_calendar_get_action_events_by_timesort", { timesortfrom: String(Math.floor(Date.now() / 1000)), limitnum: String(limit) });
      const ev = (r.events ?? []) as any[];
      return text(ev.length ? ev.map((e) => `${new Date(e.timesort * 1000).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}  ${e.course?.shortname ?? ""}  ${e.name}`).join("\n") : "Keine anstehenden Termine.");
    });

    s.registerTool("moodle_course_contents", {
      title: "Course contents",
      description: "Sections, activities and files of one Lernplattform course (id from moodle_courses). Labels and page texts are included as plain text.",
      inputSchema: { courseid: z.number().int() }, annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ courseid }) => {
      const secs = await moodle(await bycs(), "core_course_get_contents", { courseid: String(courseid) });
      const strip = (h = "") => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
      const lines: string[] = [];
      for (const sec of secs as any[]) {
        lines.push(`## ${sec.name}`);
        if (sec.summary) lines.push(strip(sec.summary).slice(0, 2000));
        for (const m of sec.modules ?? []) {
          lines.push(`- [${m.modname}] ${m.name}${m.url ? ` (${m.url})` : ""}`);
          if (m.description) lines.push("  " + strip(m.description).slice(0, 3000));
        }
      }
      return text(lines.join("\n") || "(keine Inhalte)");
    });

    // ---- memory ----
    s.registerTool("memory_save", {
      title: "Save memory",
      description: "Persist a fact or note across conversations and across AI clients.",
      inputSchema: { text: z.string().min(1), tags: z.array(z.string()).default([]) },
    }, async ({ text: t, tags }) => text(`Saved memory #${await store(this.env).memorySave(t, tags)}`));

    s.registerTool("memory_search", {
      title: "Search memory",
      description: "Search saved memories by words (all words must match). Empty query lists the newest.",
      inputSchema: { query: z.string().default(""), limit: z.number().int().min(1).max(100).default(20) },
      annotations: { readOnlyHint: true },
    }, async ({ query, limit }) => {
      const rows = await store(this.env).memorySearch(query, limit);
      return text(rows.length ? rows.map((r) => `#${r.id} [${r.created.slice(0, 10)}]${r.tags ? ` (${r.tags})` : ""} ${r.text}`).join("\n") : "No memories found.");
    });

    s.registerTool("memory_delete", {
      title: "Delete memory",
      description: "Delete a memory by its #id.",
      inputSchema: { id: z.number().int() },
      annotations: { destructiveHint: true },
    }, async ({ id }) => text((await store(this.env).memoryDelete(id)) ? `Deleted #${id}` : `No memory #${id}`));

    // ---- files (text for now; office documents come with the WOPI host) ----
    s.registerTool("fs_list", {
      title: "List files",
      description: "List stored files.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, async () => {
      const rows = await store(this.env).fileList();
      return text(rows.length ? rows.map((f) => `${f.name}  ${f.size} B  ${f.mtime.slice(0, 16)}`).join("\n") : "No files.");
    });

    s.registerTool("fs_read", {
      title: "Read file",
      description: "Read a stored text file.",
      inputSchema: { name: z.string() },
      annotations: { readOnlyHint: true },
    }, async ({ name }) => {
      const data = await store(this.env).fileGet(name);
      if (!data) return text(`No file ${name}`);
      return text(new TextDecoder().decode(data));
    });

    s.registerTool("fs_write", {
      title: "Write file",
      description: "Create or overwrite a stored text file (max 2 MB).",
      inputSchema: { name: z.string().min(1).max(200), content: z.string() },
    }, async ({ name, content }) => {
      const n = await store(this.env).filePut(name, new TextEncoder().encode(content));
      return text(`Wrote ${name} (${n} B)`);
    });

    s.registerTool("fs_delete", {
      title: "Delete file",
      description: "Delete a stored file.",
      inputSchema: { name: z.string() },
      annotations: { destructiveHint: true },
    }, async ({ name }) => text((await store(this.env).fileDelete(name)) ? `Deleted ${name}` : `No file ${name}`));

    // ---- web + utils ----
    s.registerTool("web_fetch", {
      title: "Fetch URL",
      description: "Fetch a web page and return it as readable text (HTML tags stripped).",
      inputSchema: { url: z.string().url(), maxChars: z.number().int().min(100).max(100000).default(20000) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ url, maxChars }) => {
      const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Nexus Light)" }, redirect: "follow" });
      let body = await r.text();
      if ((r.headers.get("content-type") || "").includes("html")) body = htmlToText(body);
      return text(`${r.status} ${r.url}\n\n${body.slice(0, maxChars)}`);
    });

    s.registerTool("util_time", {
      title: "Current time",
      description: "Current date and time, optionally in IANA time zones.",
      inputSchema: { zones: z.array(z.string()).default(["Europe/Berlin"]) },
      annotations: { readOnlyHint: true },
    }, async ({ zones }) => {
      const d = new Date();
      const lines = [`ISO: ${d.toISOString()}`];
      for (const tz of zones) {
        try { lines.push(`${tz}: ${new Intl.DateTimeFormat("de-DE", { timeZone: tz, dateStyle: "full", timeStyle: "long" }).format(d)}`); }
        catch { lines.push(`${tz}: invalid time zone`); }
      }
      return text(lines.join("\n"));
    });
  }
}

function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- owner sign-in + consent ----------
const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{--bg:#f6f7f9;--fg:#1d2330;--mut:#6b7280;--card:#fff;--line:#e3e6eb;--acc:#2f6fdb}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e8eaee;--mut:#9aa3af;--card:#1d2128;--line:#2c323b;--acc:#6b9cf0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:440px;margin:0 auto;padding:40px 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
h1{font-size:20px;margin:0 0 12px}p{margin:8px 0}.mut{color:var(--mut);font-size:13px}
input{width:100%;font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);margin:12px 0}
.row{display:flex;gap:8px}button{flex:1;font:inherit;padding:10px;border-radius:8px;border:0;cursor:pointer;background:var(--acc);color:#fff}
button.ghost{background:none;color:var(--fg);border:1px solid var(--line)}.warn{color:#c2410c}</style></head>
<body><main><div class="card">${body}</div></main></body></html>`;
}

function consentPage(d: ConsentDescription, handle: string, error = "") {
  return page("Nexus Light", `<h1>${esc(d.clientName || "Eine App")} möchte Zugriff auf deinen Nexus</h1>
<p>${d.clientDomain ? `Herausgeber: <strong>${esc(d.clientDomain)}</strong>` : "Die App hat sich selbst registriert, ihr Name ist nicht geprüft."}</p>
<p>Zugriff geht an: <strong>${esc(d.redirectHost)}</strong></p>
${d.redirectIsLoopback ? '<p class="warn">Der Zugriff geht an ein Programm auf diesem Gerät. Nur fortfahren, wenn du die Anmeldung gerade selbst gestartet hast.</p>' : ""}
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<input type="password" name="password" placeholder="Nexus-Passwort" autocomplete="current-password" autofocus>
${error ? `<p class="warn">${esc(error)}</p>` : ""}
<div class="row"><button name="decision" value="deny" class="ghost">Ablehnen</button><button name="decision" value="approve">Erlauben</button></div></form>
<p class="mut">Nexus Light · nur der Besitzer kennt das Passwort.</p>`);
}

async function safeEqual(a: string, b: string) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return (crypto.subtle as any).timingSafeEqual(x, y) as boolean; // Workers extension
}

const authHandler = {
  async fetch(req: Request, env: Env & { OAUTH_PROVIDER: any }) {
    const url = new URL(req.url);
    const oauth = env.OAUTH_PROVIDER;

    if (url.pathname === "/authorize" && req.method === "GET") {
      const request = await oauth.parseAuthRequest(req);
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(consentPage(details, consent.handle), { headers: consent.headers });
    }

    if (url.pathname === "/authorize" && req.method === "POST") {
      const form = await req.formData();
      const handle = String(form.get("handle") || "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(req, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      if (!env.OWNER_PASSWORD || !(await safeEqual(String(form.get("password") || ""), env.OWNER_PASSWORD))) {
        // The handle is single-use only on approve/deny, so the same form can be retried.
        return new Response(page("Nexus Light", `<h1>Falsches Passwort</h1><p><a href="javascript:history.back()">Zurück</a></p>`), { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const approved = await oauth.approveConsent(req, handle);
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request, userId: "owner", metadata: {}, scope: approved.request.scope, props: { user: "owner", origin: url.origin },
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }

    return (await handleWeb(req, env)) ?? new Response("Not found", { status: 404 });
  },
};

// The provider needs the canonical resource URL up front, which a self-hosted copy only learns
// from PUBLIC_URL or its first request, so it is built lazily.
let provider: OAuthProvider | null = null;

export default {
  /** Weekly cron: back up into the ByCS-Drive when it is set up. */
  async scheduled(_event: ScheduledController, env: Env) {
    if (!(await storeStub(env).bycsStatus())) return;
    const age = await storeStub(env).backupAge();
    if (age && (!age.ever || age.days >= 6)) console.log("ByCS backup:", await storeStub(env).backupToBycs());
  },

  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    provider ??= new OAuthProvider({
      apiRoute: "/mcp",
      apiHandler: NexusMCP.serve("/mcp", { jurisdiction: region(env) }) as any,
      defaultHandler: authHandler as any,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["nexus"],
      resourceMetadata: { resource: `${(env.PUBLIC_URL || new URL(req.url).origin).replace(/\/$/, "").toLowerCase()}/mcp` },
    });
    return provider.fetch(req, env, ctx);
  },
};

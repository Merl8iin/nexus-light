import { storeStub, docStub } from "./region";
import { testLogin, BACKUP_FOLDER } from "./bycs";
// Human side: owner sign-in, document list, the editor page, share links and the editor WebSocket.
const enc = new TextEncoder();
export const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

async function sign(env: Env, msg: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.OWNER_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** A title as a safe file name. */
export const fileName = (t: string) => t.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 100) || "Dokument";
export const shareKey = async (env: Env, id: string) => (await sign(env, "doc:" + id)).slice(0, 22);

function eq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const cookies = (req: Request) => Object.fromEntries((req.headers.get("cookie") || "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const cookie = (name: string, value: string, maxAge = 31536000) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export async function isOwner(req: Request, env: Env) {
  const s = cookies(req).nl_s;
  return !!s && !!env.OWNER_PASSWORD && eq(s, await sign(env, "owner"));
}
async function canOpen(req: Request, env: Env, id: string) {
  if (await isOwner(req, env)) return true;
  const k = cookies(req)[`nl_k_${id}`];
  return !!k && eq(k, await shareKey(env, id));
}

const STYLE = `:root{--bg:#f6f7f9;--fg:#1d2330;--mut:#6b7280;--card:#fff;--line:#e3e6eb;--acc:#2f6fdb;--paper:#fff}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#14171c;--fg:#e8eaee;--mut:#9aa3af;--card:#1d2128;--line:#2c323b;--acc:#6b9cf0;--paper:#1b1f25}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
a{color:var(--acc);text-decoration:none}.mut{color:var(--mut);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:14px}
input,button{font:inherit;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
button.primary{background:var(--acc);color:#fff;border:0;cursor:pointer}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}`;

const LEGAL_FOOTER = `<p class="mut" style="margin-top:28px;text-align:center"><a href="https://neuro-net.net/nexus-feedback/rechtliches">Rechtliche Hinweise</a> · <a href="https://neuro-net.net/nexus-feedback/impressum">Impressum</a> · Deine Daten liegen in deinem eigenen Cloudflare-Konto.</p>`;
const shell = (title: string, body: string) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#2b579a"><link rel="icon" href="/icon-192.png"><link rel="apple-touch-icon" href="/icon-180.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Nexus"><style>${STYLE} main{max-width:760px;margin:0 auto;padding:28px 16px}h1{font-size:22px;margin:0 0 14px}
.doc{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.doc:first-child{border-top:0}</style></head><body><main>${body}${LEGAL_FOOTER}</main><script src="/pwa.js" defer></script></body></html>`;

function landing(origin: string, error = "") {
  return shell("Nexus Light", `<h1>Nexus Light</h1>
<div class="card"><p>MCP-Adresse für Claude oder ChatGPT (Anmeldung per OAuth):</p><input readonly value="${esc(origin)}/mcp" onclick="this.select()" style="width:100%"></div>
<form class="card" method="post" action="/login"><p>Als Besitzer anmelden, um Dokumente zu sehen:</p>
<div class="row"><input type="password" name="password" placeholder="Nexus-Passwort" style="flex:1" autocomplete="current-password"><button class="primary">Anmelden</button></div>
${error ? `<p style="color:#c2410c">${esc(error)}</p>` : ""}</form>`);
}

function docList(origin: string, docs: { id: string; title: string; updated: string }[], bycs = false) {
  const rows = docs.map((d) => `<div class="doc"><a href="/d/${d.id}">${esc(d.title)}</a><span class="mut">${new Date(d.updated).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })} · <a href="/d/${d.id}/export.docx">.docx</a></span></div>`).join("");
  return shell("Nexus Light", `<div class="row" style="justify-content:space-between"><h1>Dokumente</h1><span class="mut"><a href="/settings">Einstellungen</a> · <a href="/logout">abmelden</a></span></div>
<form class="card row" method="post" action="/new"><input name="title" placeholder="Neues Dokument" required style="flex:1"><button class="primary">Erstellen</button></form>
<div class="card">${rows || '<span class="mut">Noch keine Dokumente. Lege eins an oder bitte deinen Agenten darum.</span>'}</div>
<div class="row" style="justify-content:space-between"><p class="mut">MCP: ${esc(origin)}/mcp</p><span class="row"><a class="mut" href="/backup.zip">Backup aller Dokumente (.zip)</a>${bycs ? `<form method="post" action="/backup/bycs" style="margin:0"><button class="mut" style="padding:4px 8px">Backup in ByCS-Drive</button></form>` : ""}</span></div>`);
}

// Word-like chrome: title bar, ribbon, grey canvas with an A4 sheet, status bar. Pure CSS; the
// client (client/editor.ts) builds the controls into #app.
const EDITOR_CSS = `
:root{--chrome:#f3f4f6;--ribbon:#fbfbfc;--line:#dfe1e5;--fg:#1f2328;--mut:#5f6368;--acc:#2b579a;--hover:#e8eaed;--on:#d3e3fd;--canvas:#e9eaee}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--chrome:#1f2125;--ribbon:#26282c;--line:#383b40;--fg:#e8eaed;--mut:#9aa0a6;--acc:#8ab4f8;--hover:#33363b;--on:#394457;--canvas:#141518}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;background:var(--canvas);color:var(--fg);font:14px/1.4 system-ui,"Segoe UI",sans-serif}
#app{display:contents}
.top{display:flex;align-items:center;gap:12px;padding:6px 14px 0;background:var(--chrome)}
.logo{width:34px;height:34px;border-radius:8px;background:var(--acc);color:#fff;display:grid;place-items:center;font-weight:700;text-decoration:none;flex:none}
.titlebox{flex:1;min-width:0}
#title{font:500 17px/1.3 system-ui,sans-serif;color:var(--fg);background:none;border:1px solid transparent;border-radius:4px;padding:2px 6px;width:min(100%,520px)}
#title:hover{border-color:var(--line)}#title:focus{outline:none;border-color:var(--acc);background:var(--ribbon)}
.menu{display:flex;gap:2px;margin:1px 0 4px}
.menu button,.menu a{font:13px system-ui,sans-serif;color:var(--fg);background:none;border:0;border-radius:4px;padding:3px 8px;cursor:pointer;text-decoration:none}
.menu button:hover,.menu a:hover{background:var(--hover)}
#people{display:flex;gap:4px}
.avatar{--c:#888;width:30px;height:30px;border-radius:50%;border:2px solid var(--c);background:var(--c);color:#fff;font:600 12px system-ui;cursor:pointer;padding:0}
.avatar.agent{background:var(--ribbon);color:var(--c);font-size:15px}
.avatar.on{box-shadow:0 0 0 3px var(--chrome),0 0 0 5px var(--c)}
.follow{font-size:12px;color:var(--mut);white-space:nowrap;display:flex;gap:4px;align-items:center}
#ribbon{display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:5px 10px;background:var(--ribbon);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.group{display:flex;align-items:center;gap:1px;padding:0 6px;border-right:1px solid var(--line)}
.group:last-child{border-right:0}
.table-tools{display:none}#ribbon.in-table .table-tools{display:flex}
#ribbon button,.colorbtn{height:30px;min-width:30px;display:inline-grid;place-items:center;background:none;border:0;border-radius:4px;color:var(--fg);cursor:pointer;padding:0 5px;font:15px Georgia,serif}
#ribbon button:hover:not(:disabled),.colorbtn:hover{background:var(--hover)}
#ribbon button.on{background:var(--on)}
#ribbon button:disabled{opacity:.35;cursor:default}
#ribbon svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
#ribbon .b{font-weight:700}#ribbon .i{font-style:italic}#ribbon .u{text-decoration:underline}#ribbon .s{text-decoration:line-through}
#ribbon select{height:28px;font:13px system-ui,sans-serif;color:var(--fg);background:var(--ribbon);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin:0 1px}
.colorbtn{position:relative}.colorbtn span{border-bottom:3px solid var(--c);line-height:1.1;font-weight:700}
.colorbtn input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
#canvas{flex:1;overflow:auto;padding:28px 16px 60px;display:flex;justify-content:center;align-items:flex-start;gap:18px}
#comments{width:290px;flex:none;position:sticky;top:0;display:grid;gap:10px;font:13px/1.45 system-ui,sans-serif}
#comments[hidden]{display:none}
#comments .chead{display:flex;justify-content:space-between;align-items:center;color:var(--fg);padding:2px 4px}
#comments .card{background:var(--ribbon);border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:grid;gap:6px;cursor:pointer;color:var(--fg)}
#comments .card.active{border-color:var(--acc);box-shadow:0 2px 10px rgba(0,0,0,.12)}
#comments .card.resolved{opacity:.6}
#comments .card p{margin:0;white-space:pre-wrap}
#comments .who{display:flex;align-items:center;gap:6px}.dot{width:9px;height:9px;border-radius:50%;flex:none}
#comments .time{color:var(--mut);font-size:11px;margin-left:auto}
#comments .reply{border-top:1px solid var(--line);padding-top:6px;display:grid;gap:3px}
#comments .quote{color:var(--mut);font-style:italic}
#comments textarea{font:13px system-ui,sans-serif;width:100%;resize:vertical;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--chrome);color:var(--fg)}
#comments .row{display:flex;gap:6px;justify-content:flex-end}
#comments button{font:12px system-ui,sans-serif;padding:4px 9px;border-radius:6px;border:1px solid var(--line);background:none;color:var(--fg);cursor:pointer}
#comments button.primary{background:var(--acc);border-color:var(--acc);color:#fff}#comments button.link{border:0;color:var(--acc)}
.ProseMirror .cmt{background:#fff3b0;border-bottom:2px solid #f2c94c}
.ProseMirror .cmt-active{background:#ffe066}.ProseMirror .cmt-done{background:none;border-bottom:0}
@media (max-width:1180px){#canvas{flex-direction:column;align-items:center}#comments{width:21cm;max-width:100%;position:static}}
#page{flex:none;width:21cm;max-width:100%;min-height:29.7cm;margin:0 auto;background:#fff;color:#1f2328;box-shadow:0 1px 3px rgba(0,0,0,.15),0 4px 14px rgba(0,0,0,.06);padding:2.5cm 2.5cm 2cm}
@media (max-width:820px){#page{padding:1.2cm 1cm;min-height:60vh}#canvas{padding:12px 8px 40px}.follow{display:none}
#ribbon{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}#ribbon::-webkit-scrollbar{display:none}.group{flex:none}
.menu{overflow-x:auto;scrollbar-width:none}.menu button,.menu a{white-space:nowrap}.top{gap:8px;padding:6px 10px 0}#title{font-size:16px}}
#statusbar{display:flex;justify-content:space-between;gap:12px;padding:4px 14px;background:var(--chrome);border-top:1px solid var(--line);font-size:12px;color:var(--mut)}
#status[data-s=connected]{color:#188038}
.ProseMirror{outline:none;white-space:pre-wrap;word-wrap:break-word;font:11pt/1.5 Calibri,Carlito,"Segoe UI",Arial,sans-serif;min-height:20cm}
.ProseMirror p{margin:0 0 8pt}
.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4{font-family:"Calibri Light",Carlito,"Segoe UI",Arial,sans-serif;font-weight:400;color:#2f5496;line-height:1.2;margin:18pt 0 6pt}
.ProseMirror h1{font-size:20pt}.ProseMirror h2{font-size:15pt}.ProseMirror h3{font-size:12.5pt;color:#1f3763}
.ProseMirror>:first-child{margin-top:0}
.ProseMirror blockquote{margin:8pt 0 8pt 0;padding:2pt 0 2pt 14pt;border-left:3px solid #c9ced6;color:#404650;font-style:italic}
.ProseMirror pre{background:#f4f5f7;padding:8pt 10pt;border-radius:4px;font:10pt/1.45 Consolas,"Courier New",monospace}
.ProseMirror ul,.ProseMirror ol{margin:0 0 8pt;padding-left:22pt}.ProseMirror li p{margin:0 0 2pt}
.ProseMirror hr{border:0;border-top:1px solid #c9ced6;margin:12pt 0}
.ProseMirror a{color:#0563c1;text-decoration:underline;cursor:text}
.lpop,.lbubble{position:absolute;z-index:20;background:var(--ribbon);color:var(--fg);border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.18);font:13px system-ui,sans-serif}
.lpop{width:min(340px,calc(100vw - 24px));padding:12px;display:grid;gap:8px}
.lpop label{display:grid;gap:3px;color:var(--mut);font-size:12px}
.lpop input{font:14px system-ui,sans-serif;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--chrome);color:var(--fg)}
.lpop .lrow{display:flex;gap:6px;justify-content:flex-end}.lerr{color:#c5221f;font-size:12px}.lerr:empty{display:none}
.lpop button,.lbubble button{font:13px system-ui,sans-serif;padding:5px 10px;border-radius:6px;border:1px solid var(--line);background:none;color:var(--fg);cursor:pointer}
.lpop button.primary{background:var(--acc);border-color:var(--acc);color:#fff}
.lbubble{display:flex;align-items:center;gap:6px;padding:6px 8px;max-width:calc(100vw - 24px)}.lbubble[hidden]{display:none}
.lbubble a{color:#0563c1;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:4px}
@media print{.lpop,.lbubble{display:none}}
.ProseMirror mark{color:inherit;padding:0 1px}
.ProseMirror img{display:block;max-width:100%;height:auto;margin:8pt auto;border-radius:2px}
.ProseMirror img[data-align=left]{margin-left:0}.ProseMirror img[data-align=right]{margin-right:0}
.ProseMirror img.ProseMirror-selectednode{outline:3px solid #2b579a;outline-offset:2px}
.imgbar button.on{background:var(--on)}
.imgbar svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;display:block}
.ProseMirror table{border-collapse:collapse;table-layout:fixed;width:100%;margin:6pt 0 10pt;overflow:hidden}
.ProseMirror td,.ProseMirror th{border:1px solid #bfc4cc;padding:4pt 6pt;vertical-align:top;position:relative;min-width:2em}
.ProseMirror th{background:#f1f3f6;font-weight:700;text-align:left}
.ProseMirror td p,.ProseMirror th p{margin:0}
.ProseMirror td,.ProseMirror th{overflow-wrap:normal;word-wrap:normal;hyphens:auto;-webkit-hyphens:auto}
.ProseMirror .selectedCell:after{content:"";position:absolute;inset:0;background:rgba(43,87,154,.15);pointer-events:none}
.ProseMirror .column-resize-handle{position:absolute;right:-2px;top:0;bottom:0;width:4px;background:#2b579a;pointer-events:none}
.ProseMirror.resize-cursor{cursor:col-resize}
.cursor{position:relative;margin:0 -1px;border-left:2px solid;word-break:normal;pointer-events:none}
.cursor .label{position:absolute;display:block;top:-1.45em;left:-2px;line-height:1;font:600 11px/1 system-ui,sans-serif;color:#fff;padding:3px 6px;border-radius:4px 4px 4px 0;white-space:nowrap;user-select:none}
.cursor.agent{border-left-width:3px;animation:blink 1.1s steps(2) infinite}
@keyframes blink{50%{border-color:transparent}}
.ProseMirror-yjs-selection{opacity:.35}
@media print{.top,#ribbon,#statusbar{display:none}body,#canvas{background:#fff;overflow:visible;display:block;padding:0}#page{box-shadow:none;width:auto;min-height:0;padding:0}.cursor,.ProseMirror-yjs-selection,#comments{display:none}.ProseMirror .cmt{background:none;border:0}@page{size:A4;margin:2.5cm 2.5cm 2cm}}
`;

type BycsStatus = { source: string; school: string; user: string; lastBackup: string | null } | null;
function settingsPage(origin: string, bycs: BycsStatus, msg = "", err = "") {
  const field = (name: string, label: string, attrs = "") => `<label style="display:grid;gap:4px;margin-bottom:10px"><span class="mut">${label}</span><input name="${name}" ${attrs} style="width:100%"></label>`;
  const connected = bycs ? `<p>Verbunden als <b>${esc(bycs.user)}</b> (Schule ${esc(bycs.school)})${bycs.source === "secrets" ? " über Cloudflare-Secrets" : ""}.</p>
<p class="mut">Backups landen im Ordner „${esc(BACKUP_FOLDER)}“ deiner Drive, automatisch jeden Montag. Letztes ByCS-Backup: ${bycs.lastBackup ? new Date(bycs.lastBackup).toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) : "noch keins"}.</p>
<div class="row"><form method="post" action="/backup/bycs" style="margin:0"><button class="primary">Jetzt Backup in die Drive</button></form>
${bycs.source === "settings" ? `<form method="post" action="/settings/bycs/disconnect" style="margin:0" onsubmit="return confirm('ByCS trennen? Die gespeicherten Zugangsdaten werden gelöscht.')"><button>Trennen</button></form>` : ""}</div>`
    : `<p>Verbinde deine BayernCloud Schule: Dann kann dein KI-Agent deine Drive und die Lernplattform lesen, und Nexus Light speichert jede Woche ein Backup in deine Drive.</p>
<form method="post" action="/settings/bycs">
${field("school", "Schulnummer (steht in deiner Drive-Adresse, z. B. <b>0284</b>.drive.bycs.de)", 'required inputmode="numeric" pattern="[0-9A-Za-z]{2,10}" placeholder="0284"')}
${field("user", "ByCS-Benutzername", 'required autocomplete="username"')}
${field("pass", "ByCS-Passwort", 'type="password" required autocomplete="current-password"')}
<button class="primary">Verbinden und testen</button></form>
<p class="mut">Das Passwort wird verschlüsselt in deinem eigenen Cloudflare-Konto gespeichert (Schlüssel aus deinem Nexus-Passwort) und nur für die Anmeldung bei der ByCS verwendet. Funktioniert nicht, wenn deine Schule Zwei-Faktor-Anmeldung nutzt.</p>`;
  return shell("Einstellungen", `<div class="row" style="justify-content:space-between"><h1>Einstellungen</h1><a class="mut" href="/">← Dokumente</a></div>
${msg ? `<div class="card" style="border-color:#188038">${msg}</div>` : ""}${err ? `<div class="card" style="border-color:#c5221f;color:#c5221f">${esc(err)}</div>` : ""}
<div class="card"><h2 style="font-size:17px;margin:0 0 8px">ByCS (BayernCloud Schule)</h2>${connected}</div>
<div class="card"><h2 style="font-size:17px;margin:0 0 8px">KI verbinden</h2><p>In ChatGPT oder Claude als Connector mit OAuth hinzufügen:</p><input readonly value="${esc(origin)}/mcp" onclick="this.select()" style="width:100%"></div>
<div class="card"><h2 style="font-size:17px;margin:0 0 8px">Backup</h2><p><a href="/backup.zip">Alle Dokumente als .zip herunterladen</a></p></div>`);
}

function editorPage(id: string, title: string, share: string | null) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#2b579a"><link rel="icon" href="/icon-192.png"><link rel="apple-touch-icon" href="/icon-180.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Nexus"><style>${EDITOR_CSS}</style></head><body>
<div id="app" data-doc="${esc(id)}" data-title="${esc(title)}"${share ? ` data-share="${esc(share)}"` : ""}></div>
<script src="/editor.js"></script><script src="/pwa.js" defer></script></body></html>`;
}

/** Everything that is not OAuth or MCP. Returns null for unknown paths. */
export async function handleWeb(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  const store = storeStub(env);

  if (p === "/") return (await isOwner(req, env)) ? html(docList(url.origin, await store.docList(), !!(await store.bycsStatus()))) : html(landing(url.origin));

  if (p === "/login" && req.method === "POST") {
    const pw = String((await req.formData()).get("password") || "");
    if (!env.OWNER_PASSWORD || !eq(await sign(env, "pw:" + pw), await sign(env, "pw:" + env.OWNER_PASSWORD))) return html(landing(url.origin, "Falsches Passwort"), 401);
    return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookie("nl_s", await sign(env, "owner")) } });
  }
  if (p === "/logout") return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookie("nl_s", "", 0) } });

  if (p === "/new" && req.method === "POST") {
    if (!(await isOwner(req, env))) return html(landing(url.origin), 401);
    const title = String((await req.formData()).get("title") || "Dokument").slice(0, 120);
    const d = await store.docCreate(title);
    return new Response(null, { status: 303, headers: { location: `/d/${d.id}` } });
  }

  const t = p.match(/^\/d\/([\w-]{1,40})\/title$/);
  if (t && req.method === "POST") {
    if (!(await canOpen(req, env, t[1]))) return new Response("forbidden", { status: 403 });
    const title = (await req.text()).trim().slice(0, 120);
    return title && (await store.docRename(t[1], title)) ? new Response("ok") : new Response("bad request", { status: 400 });
  }

  // Word export, generated inside the document's Durable Object. A share key in ?k= also works (for agent links).
  const ex = p.match(/^\/d\/([\w-]{1,40})\/export\.docx$/);
  if (ex) {
    const k = url.searchParams.get("k");
    if (!(await canOpen(req, env, ex[1])) && !(k && eq(k, await shareKey(env, ex[1])))) return new Response("forbidden", { status: 403 });
    const doc = await store.docFind(ex[1]);
    if (!doc) return new Response("not found", { status: 404 });
    const bytes = await docStub(env, doc.id).exportDocx(doc.title);
    return new Response(bytes, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName(doc.title))}.docx`, "cache-control": "no-store" } });
  }

  // Backup of everything (built in the Store object). Owner only.
  if (p === "/backup.zip") {
    if (!(await isOwner(req, env))) return html(landing(url.origin), 401);
    const { name, data } = await store.buildBackup();
    await store.setMeta("lastBackup", new Date().toISOString());
    return new Response(data, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
  }
  // Settings: connect ByCS without touching the Cloudflare dashboard. The login is tested before it is saved.
  if (p === "/settings" || p.startsWith("/settings/")) {
    if (!(await isOwner(req, env))) return html(landing(url.origin, "Bitte als Besitzer anmelden."), 401);
    if (p === "/settings/bycs" && req.method === "POST") {
      const f = await req.formData();
      const creds = { school: String(f.get("school") || "").trim(), user: String(f.get("user") || "").trim(), pass: String(f.get("pass") || "") };
      if (!/^[0-9A-Za-z]{2,10}$/.test(creds.school) || !creds.user || !creds.pass) return html(settingsPage(url.origin, null, "", "Bitte Schulnummer, Benutzername und Passwort angeben."), 400);
      try {
        const sp = await testLogin(creds);
        await store.bycsSave(creds);
        return html(settingsPage(url.origin, await store.bycsStatus(), `ByCS verbunden. Gefunden: ${sp.length} Bereiche, z. B. ${sp.slice(0, 3).map((x) => esc(x.name)).join(", ")}.`));
      } catch (e) { return html(settingsPage(url.origin, null, "", `Anmeldung fehlgeschlagen: ${(e as Error).message}`), 400); }
    }
    if (p === "/settings/bycs/disconnect" && req.method === "POST") { await store.bycsClear(); return html(settingsPage(url.origin, await store.bycsStatus(), "ByCS getrennt, Zugangsdaten gelöscht.")); }
    return html(settingsPage(url.origin, await store.bycsStatus()));
  }

  if (p === "/backup/bycs" && req.method === "POST") {
    if (!(await isOwner(req, env))) return html(landing(url.origin), 401);
    try { return html(shell("Backup", `<h1>Backup gespeichert</h1><p>${esc(await store.backupToBycs())}</p><a href="/">Zurück</a>`)); }
    catch (e) { return html(shell("Backup", `<h1>Backup fehlgeschlagen</h1><p>${esc((e as Error).message)}</p><a href="/">Zurück</a>`), 502); }
  }

  // Images: uploaded already shrunk by the browser, served with a long private cache.
  const im = p.match(/^\/d\/([\w-]{1,40})\/img(?:\/([0-9a-f]{24}))?$/);
  if (im) {
    if (!(await canOpen(req, env, im[1]))) return new Response("forbidden", { status: 403 });
    const room = docStub(env, im[1]);
    if (req.method === "POST" && !im[2]) {
      const type = (req.headers.get("content-type") || "").split(";")[0];
      if (!/^image\/(webp|jpeg|png|gif)$/.test(type)) return Response.json({ error: "Nur WebP, JPEG, PNG oder GIF" }, { status: 415 });
      try { return Response.json({ url: `/d/${im[1]}/img/${await room.putImage(await req.arrayBuffer(), type)}` }); }
      catch (e) { return Response.json({ error: (e as Error).message }, { status: 413 }); }
    }
    if (req.method === "GET" && im[2]) {
      const img = await room.getImage(im[2]);
      if (!img) return new Response("not found", { status: 404 });
      return new Response(img.data, { headers: { "content-type": img.type, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
    }
    return new Response("method not allowed", { status: 405 });
  }

  const m = p.match(/^\/d\/([\w-]{1,40})(\/ws)?$/);
  if (m) {
    const id = m[1];
    // A share link (?k=…) is traded for a cookie once, so it does not linger in the address bar.
    const k = url.searchParams.get("k");
    if (k && eq(k, await shareKey(env, id))) return new Response(null, { status: 303, headers: { location: `/d/${id}`, "set-cookie": cookie(`nl_k_${id}`, k) } });
    if (!(await canOpen(req, env, id))) return html(landing(url.origin, "Kein Zugriff auf dieses Dokument."), 403);
    const doc = await store.docFind(id);
    if (!doc) return html(shell("Nexus Light", "<h1>Dokument nicht gefunden</h1><a href='/'>Zur Übersicht</a>"), 404);
    if (m[2]) return docStub(env, id).fetch(req);
    const share = (await isOwner(req, env)) ? `${url.origin}/d/${id}?k=${await shareKey(env, id)}` : null;
    return html(editorPage(id, doc.title, share));
  }
  return null;
}

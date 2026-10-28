// ByCS (Bavarian school cloud): Drive over WebDAV/Graph and the Lernplattform (Moodle), ported from
// the full Nexus pack. Neither offers a password grant, so the browser login flows are scripted
// (Drive: auth code + PKCE through the brokered SSO; Moodle: the mobile-app launch). Optional:
// active once the owner connects ByCS on the settings page (or sets BYCS_* secrets). Breaks if the school turns on MFA or a captcha.
const AUTH = "https://auth.drive.bycs.de/realms/bycs/protocol/openid-connect";
const MOODLE = "https://lernplattform.bycs.de";
export const BACKUP_FOLDER = "cowork Dateien backup";

/** ByCS login: from the settings page (stored encrypted in the Store) or from BYCS_* secrets. */
export type Creds = { school: string; user: string; pass: string };
export const credsFromEnv = (env: Env): Creds | null => (env.BYCS_USER && env.BYCS_PASS && env.BYCS_SCHOOL ? { school: env.BYCS_SCHOOL, user: env.BYCS_USER, pass: env.BYCS_PASS } : null);
const host = (c: Creds) => `https://${c.school}.drive.bycs.de`;

// ---- cookie jar + redirect-following fetch ----
type Jar = { set(host: string, cookies: string[]): void; header(host: string): string };
function makeJar(): Jar {
  const store: { domain: string; name: string; value: string }[] = [];
  return {
    set(h, lines) {
      for (const line of lines) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        if (eq < 0) continue;
        const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
        const domain = ((/;\s*domain=([^;]+)/i.exec(line) || [])[1] ?? h).replace(/^\./, "").toLowerCase();
        const i = store.findIndex((c) => c.domain === domain && c.name === name);
        if (i >= 0) store[i].value = value; else store.push({ domain, name, value });
      }
    },
    header(h) { h = h.toLowerCase(); return store.filter((c) => h === c.domain || h.endsWith("." + c.domain)).map((c) => `${c.name}=${c.value}`).join("; "); },
  };
}
async function hop(url: string, jar: Jar, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) {
  const h = new URL(url).host;
  const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0 (Nexus Light)", ...init.headers };
  const cookie = jar.header(h);
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { method: init.method ?? "GET", body: init.body, headers, redirect: "manual" });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) jar.set(h, sc);
  return { res, location: res.headers.get("location") };
}
const loginAction = (html: string) => (/id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1] ?? null)?.replace(/&amp;/g, "&") ?? null;
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Follow redirects to the Keycloak form, post the credentials, then follow until done(location) says stop. */
async function scriptedLogin(start: string, c: Creds, done: (loc: string) => boolean, what: string) {
  const jar = makeJar();
  let url = start, page = "";
  for (let i = 0; i < 15; i++) {
    const r = await hop(url, jar);
    if (r.location) { url = new URL(r.location, url).href; continue; }
    page = await r.res.text();
    break;
  }
  const action = loginAction(page);
  if (!action) throw new Error(`${what}: Login-Formular nicht gefunden (Zwei-Faktor, Captcha oder geänderte Seite?)`);
  const form = new URLSearchParams({ username: c.user, password: c.pass, credentialId: "" });
  let loc = (await hop(action, jar, { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded" } })).location;
  for (let i = 0; i < 15 && loc; i++) {
    if (done(loc)) return loc;
    const next = await hop(loc, jar);
    loc = next.location ? new URL(next.location, loc).href : null;
  }
  throw new Error(`${what}: Anmeldung fehlgeschlagen (falsches Passwort oder zusätzlicher Schritt)`);
}

// ---- Drive ----
const driveCache = new Map<string, { token: string; expires: number }>();
const key = (c: Creds) => `${c.school}:${c.user}`;
async function driveToken(c: Creds) {
  const hit = driveCache.get(key(c));
  if (hit && Date.now() < hit.expires) return hit.token;
  const client = `school-${c.school}-web`, redirect = `${host(c)}/oidc-callback.html`;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({ client_id: client, response_type: "code", scope: "openid", code_challenge_method: "S256", code_challenge: challenge, redirect_uri: redirect });
  const loc = await scriptedLogin(`${AUTH}/auth?${params}`, c, (l) => l.startsWith(redirect), "ByCS-Drive");
  const code = new URL(loc).searchParams.get("code");
  const tok = await fetch(`${AUTH}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: client, grant_type: "authorization_code", code: code ?? "", redirect_uri: redirect, code_verifier: verifier }) }).then((r) => r.json<any>());
  if (!tok.access_token) throw new Error(`ByCS-Drive: Token-Tausch fehlgeschlagen (${tok.error ?? "unbekannt"})`);
  driveCache.set(key(c), { token: tok.access_token, expires: Date.now() + (tok.expires_in - 30) * 1000 });
  return tok.access_token as string;
}

async function graph(c: Creds, p: string) {
  const r = await fetch(`${host(c)}/graph/v1.0${p}`, { headers: { Authorization: `Bearer ${await driveToken(c)}` } });
  if (!r.ok) throw new Error(`ByCS-Drive ${p}: HTTP ${r.status}`);
  return r.json<any>();
}
export async function spaces(c: Creds) {
  return ((await graph(c, "/me/drives")).value as any[]).map((d) => ({ name: d.name as string, id: d.id as string, type: d.driveType as string }));
}
async function resolveSpace(c: Creds, ref?: string) {
  const all = await spaces(c);
  const hit = !ref ? all.find((s) => s.type === "personal")
    : all.find((s) => s.id === ref) ?? all.find((s) => s.name.toLowerCase() === ref.toLowerCase()) ?? all.find((s) => s.name.toLowerCase().includes(ref.toLowerCase()));
  if (!hit) throw new Error(ref ? `Kein Bereich passt zu "${ref}".` : "Kein persönlicher Bereich gefunden.");
  return hit;
}
const davUrl = (c: Creds, space: string, p: string) => `${host(c)}/dav/spaces/${space}${p.split("/").map(encodeURIComponent).join("/")}`;

async function dav(c: Creds, method: string, url: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  return fetch(url, { method, body: init.body, headers: { Authorization: `Bearer ${await driveToken(c)}`, ...init.headers } });
}

export async function listFolder(c: Creds, space: string | undefined, p = "/") {
  const sp = await resolveSpace(c, space);
  if (!p.startsWith("/")) p = "/" + p;
  if (!p.endsWith("/")) p += "/";
  const xml = await (await dav(c, "PROPFIND", davUrl(c, sp.id, p), { headers: { Depth: "1" } })).text();
  const items: { name: string; dir: boolean; size: number; mtime: string }[] = [];
  for (const m of xml.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)) {
    const b = m[1];
    const rel = decodeURIComponent((/<d:href>([^<]+)<\/d:href>/.exec(b) ?? [])[1] ?? "").split(sp.id)[1] ?? "";
    if (!rel || rel === p || rel === "/") continue;
    items.push({
      name: decodeURIComponent(rel.replace(/\/$/, "").split("/").pop() ?? ""),
      dir: /<d:collection\s*\/>/.test(b),
      size: +((/<oc:size>(\d+)<\/oc:size>/.exec(b) ?? /<d:getcontentlength>(\d+)<\/d:getcontentlength>/.exec(b) ?? [])[1] ?? 0),
      mtime: ((/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/.exec(b) ?? [])[1] ?? "").slice(5, 22),
    });
  }
  items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, "de", { numeric: true }) : a.dir ? -1 : 1));
  return { space: sp.name, path: p, items };
}

/** Log in from scratch and list the Drive spaces: used by the settings page to check a login. */
export async function testLogin(c: Creds) {
  driveCache.delete(key(c));
  return spaces(c);
}

/** Upload a file into a folder of the personal space (folder is created if missing). */
export async function uploadFile(c: Creds, folder: string, name: string, data: Uint8Array, type: string) {
  const sp = await resolveSpace(c);
  const dir = `/${folder.replace(/^\/|\/$/g, "")}/`;
  const mk = await dav(c, "MKCOL", davUrl(c, sp.id, dir));
  if (![201, 405].includes(mk.status)) throw new Error(`Ordner „${folder}“ konnte nicht angelegt werden (HTTP ${mk.status})`);
  const put = await dav(c, "PUT", davUrl(c, sp.id, dir + name), { body: data, headers: { "Content-Type": type } });
  if (!put.ok) throw new Error(`Hochladen fehlgeschlagen (HTTP ${put.status})`);
  return `${sp.name}${dir}${name}`;
}

// ---- Lernplattform (Moodle) ----
const moodleCache = new Map<string, { token: string; me?: any }>();
async function moodleToken(c: Creds) {
  const hit = moodleCache.get(key(c));
  if (hit) return hit.token;
  const loc = await scriptedLogin(`${MOODLE}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=1.0&urlscheme=moodlemobile`, c, (l) => l.startsWith("moodlemobile://"), "Lernplattform");
  const parts = atob(loc.split("token=")[1]).split(":::");
  const token = parts.length > 1 ? parts[1] : parts[0];
  moodleCache.set(key(c), { token });
  return token;
}
export async function moodle(c: Creds, wsfunction: string, args: Record<string, string> = {}) {
  const body = new URLSearchParams({ wstoken: await moodleToken(c), moodlewsrestformat: "json", wsfunction, ...args });
  const r = await fetch(`${MOODLE}/webservice/rest/server.php`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }).then((x) => x.json<any>());
  if (r?.exception) throw new Error(`Lernplattform ${wsfunction}: ${r.message}`);
  return r;
}
export async function moodleMe(c: Creds) {
  await moodleToken(c);
  const entry = moodleCache.get(key(c))!;
  return (entry.me ??= await moodle(c, "core_webservice_get_site_info"));
}

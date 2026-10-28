// Browser editor: a word-processor UI around ProseMirror, bound to the document's Yjs doc over y-websocket.
// Everyone's cursor is shown (the agent's included), and the view can follow the agent while it writes.
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { ySyncPlugin, yCursorPlugin, yUndoPlugin, yCursorPluginKey, undoCommand as undo, redoCommand as redo } from "y-prosemirror";
import { EditorState, Plugin, TextSelection, type Command, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { MarkType, NodeType, Mark } from "prosemirror-model";
import { wrapInList, splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark, setBlockType, wrapIn, lift } from "prosemirror-commands";
import { columnResizing, tableEditing, goToNextCell, addRowAfter, addColumnAfter, deleteRow, deleteColumn, deleteTable, isInTable } from "prosemirror-tables";
import { schema } from "./schema";
import { svg } from "./icons";
import { linkCommand, linkPlugin } from "./links";
import { imageCommand, imagePlugin, initImages } from "./images";
import { commentCommand, commentPlugin, initComments } from "./comments";

const app = document.getElementById("app")!;
const docId = app.dataset.doc!;
const N = schema.nodes, M = schema.marks;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const h = (tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === "class" ? (el.className = v) : el.setAttribute(k, v);
  el.append(...kids);
  return el;
};

// ---------- who am I ----------
const COLORS = ["#2f6fdb", "#c2410c", "#7c3aed", "#0f766e", "#be123c", "#4d7c0f"];
let me = { name: "", color: "" };
try { me = JSON.parse(localStorage.getItem("nl-user") || "null") || me; } catch {}
if (!me.name) {
  me.name = (prompt("Dein Name (für die anderen im Dokument):") || "Gast").slice(0, 30);
  me.color = COLORS[Math.floor(Math.random() * COLORS.length)];
  try { localStorage.setItem("nl-user", JSON.stringify(me)); } catch {}
}

// ---------- layout ----------

app.append(
  h("header", { class: "top" },
    h("a", { href: "/", class: "logo", title: "Alle Dokumente" }, "N"),
    h("div", { class: "titlebox" },
      h("input", { id: "title", value: app.dataset.title || "", spellcheck: "false", "aria-label": "Titel" }),
      h("nav", { class: "menu" },
        h("a", { href: `/d/${docId}/export.docx`, id: "m-docx" }, "Als Word (.docx)"),
        h("button", { id: "m-print" }, "Drucken / PDF"),
        ...(app.dataset.share ? [h("button", { id: "m-share" }, "Teilen")] : []),
        h("a", { href: "/" }, "Alle Dokumente"))),
    h("div", { id: "people" }),
    h("label", { class: "follow", title: "Ansicht folgt dem Agenten, sobald er schreibt" }, h("input", { type: "checkbox", id: "autofollow", checked: "" }), " Agent folgen")),
  h("div", { id: "ribbon" }),
  h("div", { id: "canvas" }, h("div", { id: "page" }), h("aside", { id: "comments", hidden: "" })),
  h("footer", { id: "statusbar" }, h("span", { id: "count" }), h("span", { id: "status" }, "verbinde …")),
);

// ---------- sync ----------
const ydoc = new Y.Doc();
const proto = location.protocol === "https:" ? "wss" : "ws";
const provider = new WebsocketProvider(`${proto}://${location.host}/d/${encodeURIComponent(docId)}`, "ws", ydoc);
provider.awareness.setLocalStateField("user", { name: me.name, color: me.color });

// ---------- commands ----------
const mark = (t: MarkType): Command => toggleMark(t);
const setAlign = (align: string | null): Command => (state, dispatch) => {
  const tr = state.tr;
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
    if (node.type === N.paragraph || node.type === N.heading) tr.setNodeMarkup(pos, undefined, { ...node.attrs, align: align === "left" ? null : align });
  });
  if (dispatch) dispatch(tr);
  return true;
};
/** Merge attrs into the textStyle mark over the selection (or the stored marks at the cursor). */
const setTextStyle = (attrs: Record<string, string | null>): Command => (state, dispatch) => {
  const { from, to, empty } = state.selection;
  const current = (empty ? state.storedMarks || state.selection.$from.marks() : marksIn(state, from, to)).find((m) => m.type === M.textStyle);
  const next = M.textStyle.create({ ...(current?.attrs ?? {}), ...attrs });
  const clean = Object.values(next.attrs).every((v) => v == null);
  if (dispatch) {
    const tr = state.tr;
    if (empty) clean ? tr.removeStoredMark(M.textStyle) : tr.addStoredMark(next);
    else { tr.removeMark(from, to, M.textStyle); if (!clean) tr.addMark(from, to, next); }
    dispatch(tr);
  }
  return true;
};
const setHighlight = (color: string | null): Command => (state, dispatch) => {
  const { from, to, empty } = state.selection;
  if (empty) return false;
  if (dispatch) { const tr = state.tr.removeMark(from, to, M.highlight); if (color) tr.addMark(from, to, M.highlight.create({ color })); dispatch(tr); }
  return true;
};
const clearFormat: Command = (state, dispatch) => {
  const { from, to } = state.selection;
  if (dispatch) { const tr = state.tr; for (const m of Object.values(M)) tr.removeMark(from, to, m); dispatch(tr.setStoredMarks([])); }
  return true;
};
const insertTable: Command = (state, dispatch) => {
  const cell = (head: boolean) => (head ? N.table_header : N.table_cell).createAndFill()!;
  const row = (head: boolean) => N.table_row.create(null, [cell(head), cell(head), cell(head)]);
  const table = N.table.create(null, [row(true), row(false), row(false)]);
  if (dispatch) { const tr = state.tr.replaceSelectionWith(table); dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(state.selection.from + 3))).scrollIntoView()); }
  return true;
};
const insertRule: Command = (state, dispatch) => { if (dispatch) dispatch(state.tr.replaceSelectionWith(N.horizontal_rule.create()).scrollIntoView()); return true; };
function marksIn(state: EditorState, from: number, to: number) {
  const out: Mark[] = [];
  state.doc.nodesBetween(from, to, (n) => { out.push(...n.marks); });
  return out;
}

// ---------- editor ----------
initComments(ydoc, me, $("#comments"));
initImages(docId, (msg) => { const el = $("#status"); if (msg) { el.textContent = msg; el.dataset.s = "busy"; } else provider.emit("status", [{ status: provider.wsconnected ? "connected" : "connecting" }]); });
const view = new EditorView($("#page"), {
  state: EditorState.create({
    schema,
    plugins: [
      ySyncPlugin(ydoc.getXmlFragment("prosemirror")),
      yCursorPlugin(provider.awareness, { cursorBuilder }),
      yUndoPlugin(),
      columnResizing(), tableEditing(),
      keymap({
        "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo,
        "Mod-b": mark(M.strong), "Mod-i": mark(M.em), "Mod-u": mark(M.underline), "Mod-k": linkCommand, "Mod-Alt-m": commentCommand,
        "Mod-Alt-1": setBlockType(N.heading, { level: 1 }), "Mod-Alt-2": setBlockType(N.heading, { level: 2 }), "Mod-Alt-0": setBlockType(N.paragraph),
        "Mod-l": setAlign("left"), "Mod-e": setAlign("center"), "Mod-r": setAlign("right"), "Mod-j": setAlign("justify"),
        Tab: (s, d) => goToNextCell(1)(s, d) || sinkListItem(N.list_item)(s, d) || true,
        "Shift-Tab": (s, d) => goToNextCell(-1)(s, d) || liftListItem(N.list_item)(s, d) || true,
        Enter: splitListItem(N.list_item),
      }),
      keymap(baseKeymap),
      linkPlugin(), imagePlugin(), commentPlugin(),
      new Plugin({ view: () => ({ update: (v) => refresh(v) }) }),
    ],
  }),
  attributes: { spellcheck: "true", lang: "de" },
});

// y-prosemirror skips redrawing remote cursors when a text change and a cursor move arrive together,
// so the agent's label lags while it types. Redraw once per frame after remote changes.
let cursorFrame = 0;
ydoc.on("update", (_u: Uint8Array, origin: unknown) => {
  if (origin !== provider || cursorFrame) return;
  cursorFrame = requestAnimationFrame(() => { cursorFrame = 0; view.dispatch(view.state.tr.setMeta(yCursorPluginKey, { awarenessUpdated: true })); });
});

function cursorBuilder(user: { name: string; color: string; agent?: boolean }) {
  const c = h("span", { class: "cursor" + (user.agent ? " agent" : "") });
  c.style.borderColor = user.color;
  const label = h("span", { class: "label" }, (user.agent ? "✦ " : "") + user.name);
  label.style.background = user.color;
  c.append(label);
  return c;
}

// ---------- ribbon ----------
type Item = { kind: "btn"; icon?: string; text?: string; title: string; cmd: Command; active?: (s: EditorState) => boolean; cls?: string; table?: boolean }
  | { kind: "select"; id: string; title: string; options: [string, string][]; onChange: (v: string) => Command; width?: string }
  | { kind: "color"; id: string; title: string; text: string; icon?: string; onChange: (v: string) => Command };

const STYLES: [string, string][] = [["p", "Standard"], ["h1", "Überschrift 1"], ["h2", "Überschrift 2"], ["h3", "Überschrift 3"], ["quote", "Zitat"], ["code", "Code"]];
const FONTS: [string, string][] = [["", "Calibri"], ["Arial, Helvetica, sans-serif", "Arial"], ["'Times New Roman', Times, serif", "Times New Roman"], ["Georgia, serif", "Georgia"], ["Verdana, sans-serif", "Verdana"], ["'Courier New', monospace", "Courier New"]];
const SIZES: [string, string][] = [["", "11"], ...[8, 9, 10, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72].map((n) => [`${n}pt`, String(n)] as [string, string])].sort((a, b) => parseInt(a[1]) - parseInt(b[1]));
const hasMark = (t: MarkType) => (s: EditorState) => { const { from, to, empty } = s.selection; return empty ? !!t.isInSet(s.storedMarks || s.selection.$from.marks()) : s.doc.rangeHasMark(from, to, t); };
const blockAlign = (a: string) => (s: EditorState) => (s.selection.$from.parent.attrs.align ?? "left") === a;
const setStyle = (v: string): Command => {
  if (v === "quote") return wrapIn(N.blockquote);
  if (v === "code") return setBlockType(N.code_block);
  if (v.startsWith("h")) return setBlockType(N.heading, { level: Number(v[1]) });
  return (s, d) => setBlockType(N.paragraph)(s, d) || lift(s, d);
};

const groups: Item[][] = [
  [{ kind: "btn", icon: "undo", title: "Rückgängig (Strg+Z)", cmd: undo }, { kind: "btn", icon: "redo", title: "Wiederholen (Strg+Y)", cmd: redo }],
  [{ kind: "select", id: "style", title: "Formatvorlage", options: STYLES, onChange: setStyle, width: "128px" }],
  [{ kind: "select", id: "font", title: "Schriftart", options: FONTS, onChange: (v) => setTextStyle({ fontFamily: v || null }), width: "124px" },
   { kind: "select", id: "size", title: "Schriftgröße", options: SIZES, onChange: (v) => setTextStyle({ fontSize: v || null }), width: "58px" }],
  [{ kind: "btn", text: "B", cls: "b", title: "Fett (Strg+B)", cmd: mark(M.strong), active: hasMark(M.strong) },
   { kind: "btn", text: "I", cls: "i", title: "Kursiv (Strg+I)", cmd: mark(M.em), active: hasMark(M.em) },
   { kind: "btn", text: "U", cls: "u", title: "Unterstrichen (Strg+U)", cmd: mark(M.underline), active: hasMark(M.underline) },
   { kind: "btn", text: "S", cls: "s", title: "Durchgestrichen", cmd: mark(M.strike), active: hasMark(M.strike) },
   { kind: "color", id: "color", title: "Schriftfarbe", text: "A", onChange: (v) => setTextStyle({ color: v }) },
   { kind: "color", id: "mark", title: "Hervorheben", text: "", icon: "highlight", onChange: (v) => setHighlight(v) },
   { kind: "btn", icon: "clear", title: "Formatierung entfernen", cmd: clearFormat }],
  [{ kind: "btn", icon: "left", title: "Linksbündig (Strg+L)", cmd: setAlign("left"), active: blockAlign("left") },
   { kind: "btn", icon: "center", title: "Zentriert (Strg+E)", cmd: setAlign("center"), active: blockAlign("center") },
   { kind: "btn", icon: "right", title: "Rechtsbündig (Strg+R)", cmd: setAlign("right"), active: blockAlign("right") },
   { kind: "btn", icon: "justify", title: "Blocksatz (Strg+J)", cmd: setAlign("justify"), active: blockAlign("justify") }],
  [{ kind: "btn", icon: "bullet", title: "Aufzählung", cmd: wrapInList(N.bullet_list) },
   { kind: "btn", icon: "ordered", title: "Nummerierung", cmd: wrapInList(N.ordered_list) },
   { kind: "btn", icon: "outdent", title: "Einzug verkleinern", cmd: (s, d) => liftListItem(N.list_item)(s, d) || lift(s, d) },
   { kind: "btn", icon: "indent", title: "Einzug vergrößern", cmd: sinkListItem(N.list_item) }],
  [{ kind: "btn", icon: "table", title: "Tabelle einfügen", cmd: insertTable },
   { kind: "btn", icon: "image", title: "Bild einfügen (auch per Einfügen oder Ziehen)", cmd: imageCommand },
   { kind: "btn", icon: "link", title: "Link einfügen (Strg+K)", cmd: linkCommand, active: hasMark(M.link) },
   { kind: "btn", icon: "comment", title: "Kommentar (Text markieren, Strg+Alt+M)", cmd: commentCommand },
   { kind: "btn", icon: "quote", title: "Zitat", cmd: wrapIn(N.blockquote) },
   { kind: "btn", icon: "rule", title: "Trennlinie", cmd: insertRule }],
  [{ kind: "btn", icon: "rowAdd", title: "Zeile darunter einfügen", cmd: addRowAfter, table: true },
   { kind: "btn", icon: "colAdd", title: "Spalte rechts einfügen", cmd: addColumnAfter, table: true },
   { kind: "btn", icon: "rowDel", title: "Zeile löschen", cmd: deleteRow, table: true },
   { kind: "btn", icon: "colDel", title: "Spalte löschen", cmd: deleteColumn, table: true },
   { kind: "btn", icon: "tableDel", title: "Tabelle löschen", cmd: deleteTable, table: true }],
];

const run = (cmd: Command) => { cmd(view.state, view.dispatch, view); view.focus(); };
const refreshers: ((s: EditorState) => void)[] = [];
for (const group of groups) {
  const g = h("div", { class: "group" + (group.every((i) => i.kind === "btn" && i.table) ? " table-tools" : "") });
  for (const item of group) {
    if (item.kind === "btn") {
      const b = h("button", { title: item.title, "aria-label": item.title, class: item.cls ?? "" }, item.icon ? svg(item.icon) : item.text ?? "");
      b.onmousedown = (e) => { e.preventDefault(); run(item.cmd); };
      refreshers.push((s) => { b.classList.toggle("on", !!item.active?.(s)); if (!item.table) (b as HTMLButtonElement).disabled = !item.cmd(s); });
      g.append(b);
    } else if (item.kind === "select") {
      const sel = h("select", { id: item.id, title: item.title, "aria-label": item.title }, ...item.options.map(([v, t]) => h("option", { value: v }, t))) as HTMLSelectElement;
      if (item.width) sel.style.width = item.width;
      sel.onchange = () => run(item.onChange(sel.value));
      g.append(sel);
    } else {
      const input = h("input", { type: "color", id: item.id, value: item.id === "mark" ? "#fff59d" : "#c00000" }) as HTMLInputElement;
      const label = h("label", { class: "colorbtn", title: item.title }, h("span", {}, item.icon ? svg(item.icon) : item.text), input);
      input.oninput = () => { label.style.setProperty("--c", input.value); run(item.onChange(input.value)); };
      label.style.setProperty("--c", input.value);
      g.append(label);
    }
  }
  $("#ribbon").append(g);
}

function refresh(v: EditorView) {
  const s = v.state;
  for (const r of refreshers) r(s);
  $("#ribbon").classList.toggle("in-table", isInTable(s));
  const p = s.selection.$from.parent;
  const inQuote = s.selection.$from.node(Math.max(0, s.selection.$from.depth - 1))?.type === N.blockquote;
  ($("#style") as HTMLSelectElement).value = p.type === N.heading ? `h${p.attrs.level}` : p.type === N.code_block ? "code" : inQuote ? "quote" : "p";
  const ts = (s.selection.empty ? s.storedMarks || s.selection.$from.marks() : marksIn(s, s.selection.from, s.selection.to)).find((m) => m.type === M.textStyle);
  ($("#font") as HTMLSelectElement).value = ts?.attrs.fontFamily ?? "";
  ($("#size") as HTMLSelectElement).value = ts?.attrs.fontSize ?? "";
  updateCount();
}

// ---------- status bar ----------
let countTimer = 0;
function updateCount() {
  clearTimeout(countTimer);
  countTimer = window.setTimeout(() => {
    const text = view.state.doc.textBetween(0, view.state.doc.content.size, " ", " ");
    const words = (text.match(/\S+/g) || []).length;
    const pageH = 29.7 * 37.8; // A4 at 96 dpi
    const pages = Math.max(1, Math.ceil(($("#page").scrollHeight - 2) / pageH));
    $("#count").textContent = `Seite ${pages > 1 ? `1–${pages}` : 1} · ${words} Wörter · ${text.replace(/\s/g, "").length} Zeichen`;
  }, 150);
}
provider.on("status", ({ status: s }: { status: string }) => { const el = $("#status"); el.textContent = s === "connected" ? "● gespeichert & verbunden" : "○ verbinde …"; el.dataset.s = s; });

// ---------- title, menu ----------
const title = $<HTMLInputElement>("#title");
let saved = title.value;
const saveTitle = async () => {
  const t = title.value.trim();
  if (!t || t === saved) { title.value = saved; return; }
  const r = await fetch(`/d/${docId}/title`, { method: "POST", body: t });
  if (r.ok) { saved = t; document.title = t; } else title.value = saved;
};
title.onblur = saveTitle;
title.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } if (e.key === "Escape") { title.value = saved; title.blur(); } };
$("#m-print").onclick = () => window.print();
const share = document.getElementById("m-share");
if (share) share.onclick = () => navigator.clipboard.writeText(app.dataset.share!).then(() => { share.textContent = "Link kopiert ✓"; setTimeout(() => (share.textContent = "Teilen"), 2000); });

// ---------- presence + following the agent ----------
const people = $("#people");
let following: number | null = null;
function renderPeople() {
  people.innerHTML = "";
  for (const [id, s] of provider.awareness.getStates()) {
    if (!s.user) continue;
    const initials = s.user.name.split(/\s+/).map((w: string) => w[0]).join("").slice(0, 2).toUpperCase();
    const chip = h("button", { class: "avatar" + (s.user.agent ? " agent" : "") + (following === id ? " on" : ""), title: s.user.name + (id === ydoc.clientID ? " (du)" : following === id ? " · folgen beenden" : " · folgen") }, s.user.agent ? "✦" : initials);
    chip.style.setProperty("--c", s.user.color);
    if (id !== ydoc.clientID) chip.onclick = () => { following = following === id ? null : id; renderPeople(); follow(); };
    people.append(chip);
  }
}
function follow() {
  if (following == null) return;
  const s = provider.awareness.getStates().get(following);
  if (!s?.user) return;
  requestAnimationFrame(() => {
    for (const el of document.querySelectorAll<HTMLElement>("#page .cursor")) {
      if (el.querySelector(".label")?.textContent?.endsWith(s.user.name)) { el.scrollIntoView({ block: "center", behavior: "smooth" }); break; }
    }
  });
}
provider.awareness.on("change", ({ added, updated }: { added: number[]; updated: number[] }) => {
  if (following == null && $<HTMLInputElement>("#autofollow").checked) {
    for (const id of [...added, ...updated]) {
      const s = provider.awareness.getStates().get(id);
      if (s?.user?.agent && s.cursor) { following = id; break; }
    }
  }
  renderPeople();
  follow();
});
view.dom.addEventListener("mousedown", () => { if (following != null) { following = null; renderPeople(); } });
renderPeople();
refresh(view);
view.focus();

// Comments: threads live in the shared Yjs map "comments" (id -> thread), anchored in the text by a
// `comment` mark carrying the id. A side panel lists them in document order; people and agents can
// add, reply, resolve and delete. Resolved threads keep their anchor but lose the highlight.
import * as Y from "yjs";
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { schema } from "./schema";

export type Reply = { author: string; color: string; agent?: boolean; text: string; created: string };
export type Thread = Reply & { id: string; resolved?: boolean; replies: Reply[] };

const CMT = schema.marks.comment;
const key = new PluginKey<{ active: string | null }>("comments");
let map: Y.Map<Thread>, me: { name: string; color: string }, panel: HTMLElement, showResolved = false, composing: { from: number; to: number } | null = null;

const el = (tag: string, cls = "", ...kids: (Node | string)[]) => { const e = document.createElement(tag); if (cls) e.className = cls; e.append(...kids); return e; };
const when = (iso: string) => new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Where each comment's anchor starts and ends in the document. */
function anchors(state: EditorState) {
  const out = new Map<string, { from: number; to: number }>();
  state.doc.descendants((node, pos) => {
    for (const m of node.marks) if (m.type === CMT) {
      const a = out.get(m.attrs.id);
      out.set(m.attrs.id, a ? { from: Math.min(a.from, pos), to: Math.max(a.to, pos + node.nodeSize) } : { from: pos, to: pos + node.nodeSize });
    }
  });
  return out;
}

export function initComments(ydoc: Y.Doc, user: { name: string; color: string }, container: HTMLElement) {
  map = ydoc.getMap("comments") as Y.Map<Thread>;
  me = user; panel = container;
}

export const commentCommand: Command = (state, dispatch, view) => {
  if (!state.doc.textBetween(state.selection.from, state.selection.to, " ").trim()) return false;
  if (dispatch && view) { composing = { from: state.selection.from, to: state.selection.to }; render(view); }
  return true;
};

function addThread(view: EditorView, range: { from: number; to: number }, text: string) {
  const id = Math.random().toString(36).slice(2, 10);
  map.set(id, { id, author: me.name, color: me.color, text, created: new Date().toISOString(), replies: [] });
  view.dispatch(view.state.tr.addMark(range.from, range.to, CMT.create({ id })));
}
function update(id: string, change: (t: Thread) => Thread) { const t = map.get(id); if (t) map.set(id, change(structuredClone(t))); }
function remove(view: EditorView, id: string) {
  const tr = view.state.tr;
  view.state.doc.descendants((node, pos) => { for (const m of node.marks) if (m.type === CMT && m.attrs.id === id) tr.removeMark(pos, pos + node.nodeSize, m); });
  view.dispatch(tr);
  map.delete(id);
}

function render(view: EditorView) {
  const pos = anchors(view.state);
  const active = key.getState(view.state)?.active;
  const threads = [...map.values()].filter((t) => pos.has(t.id) && (showResolved || !t.resolved)).sort((a, b) => pos.get(a.id)!.from - pos.get(b.id)!.from);
  const resolvedCount = [...map.values()].filter((t) => t.resolved && pos.has(t.id)).length;
  panel.replaceChildren();
  panel.hidden = !threads.length && !composing && !resolvedCount;
  document.body.classList.toggle("has-comments", !panel.hidden);
  const head = el("div", "chead", el("strong", "", "Kommentare"));
  if (resolvedCount) { const t = el("button", "link", showResolved ? "Erledigte ausblenden" : `${resolvedCount} erledigt`); t.onclick = () => { showResolved = !showResolved; render(view); }; head.append(t); }
  panel.append(head);

  if (composing) {
    const range = composing;
    const ta = el("textarea") as HTMLTextAreaElement;
    ta.placeholder = "Kommentar schreiben …";
    const ok = el("button", "primary", "Kommentieren"), cancel = el("button", "", "Abbrechen");
    const quote = view.state.doc.textBetween(range.from, range.to, " ").slice(0, 80);
    ok.onclick = () => { if (ta.value.trim()) addThread(view, range, ta.value.trim()); composing = null; render(view); view.focus(); };
    cancel.onclick = () => { composing = null; render(view); view.focus(); };
    ta.onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ok.click(); if (e.key === "Escape") cancel.click(); };
    panel.append(el("div", "card active", el("div", "quote", `„${quote}“`), ta, el("div", "row", cancel, ok)));
    setTimeout(() => ta.focus());
  }

  for (const t of threads) {
    const who = (r: Reply) => { const d = el("span", "dot"); d.style.background = r.color; return el("div", "who", d, el("b", "", (r.agent ? "✦ " : "") + r.author), el("span", "time", when(r.created))); };
    const card = el("div", "card" + (t.id === active ? " active" : "") + (t.resolved ? " resolved" : ""), who(t), el("p", "", t.text));
    for (const r of t.replies) card.append(el("div", "reply", who(r), el("p", "", r.text)));
    const replyBox = el("textarea") as HTMLTextAreaElement;
    replyBox.placeholder = "Antworten …";
    replyBox.rows = 1;
    replyBox.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && replyBox.value.trim()) {
        e.preventDefault();
        update(t.id, (x) => ({ ...x, replies: [...x.replies, { author: me.name, color: me.color, text: replyBox.value.trim(), created: new Date().toISOString() }] }));
      }
    };
    const resolve = el("button", "", t.resolved ? "Wieder öffnen" : "Erledigt");
    resolve.onclick = (e) => { e.stopPropagation(); update(t.id, (x) => ({ ...x, resolved: !x.resolved })); };
    const del = el("button", "", "Löschen");
    del.onclick = (e) => { e.stopPropagation(); if (confirm("Kommentar löschen?")) remove(view, t.id); };
    card.append(replyBox, el("div", "row", resolve, del));
    card.onclick = (e) => {
      if ((e.target as HTMLElement).closest("textarea,button")) return;
      const a = pos.get(t.id)!;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, a.from, a.to)).setMeta(key, { active: t.id }).scrollIntoView());
      view.focus();
    };
    panel.append(card);
  }
}

export function commentPlugin() {
  let timer = 0;
  return new Plugin({
    key,
    state: {
      init: () => ({ active: null as string | null }),
      apply(tr, v, _old, state) {
        const meta = tr.getMeta(key);
        if (meta) return meta;
        if (!tr.selectionSet && !tr.docChanged) return v;
        const m = state.selection.$from.marks().find((x) => x.type === CMT) ?? state.selection.$from.nodeAfter?.marks.find((x) => x.type === CMT);
        return { active: m?.attrs.id ?? null };
      },
    },
    props: {
      // Resolved threads keep their anchor but lose the highlight; the active one is emphasised.
      decorations(state) {
        if (!map) return null;
        const decos: Decoration[] = [];
        const active = key.getState(state)?.active;
        for (const [id, a] of anchors(state)) {
          const t = map.get(id);
          if (t?.resolved) decos.push(Decoration.inline(a.from, a.to, { class: "cmt-done" }));
          else if (id === active) decos.push(Decoration.inline(a.from, a.to, { class: "cmt-active" }));
        }
        return DecorationSet.create(state.doc, decos);
      },
    },
    view(view) {
      const rerender = () => { clearTimeout(timer); timer = window.setTimeout(() => { render(view); view.dispatch(view.state.tr.setMeta("cmt-refresh", true)); }, 60); };
      map.observe(rerender);
      render(view);
      return { update: (v, prev) => { if (v.state.doc !== prev.doc || key.getState(v.state)?.active !== key.getState(prev)?.active) { clearTimeout(timer); timer = window.setTimeout(() => render(v), 60); } }, destroy: () => map.unobserve(rerender) };
    },
  });
}

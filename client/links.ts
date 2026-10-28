// Hyperlinks: Ctrl+K / toolbar dialog, a bubble when the cursor is in a link (open, edit, remove),
// Ctrl+click to open, auto-linking typed URLs, and pasting a URL onto selected text.
import { Plugin, TextSelection, type EditorState, type Command } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Mark } from "prosemirror-model";
import { schema } from "./schema";

const LINK = schema.marks.link;
const URLISH = /(?:https?:\/\/|www\.)[^\s<>"]+$/i;

/** Accept http(s), mailto and tel; give bare domains https://. Anything else (javascript:, data:) is refused. */
export function normalizeHref(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if (/^[a-z][\w+.-]*:/i.test(s)) return null;
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s)) return "mailto:" + s;
  if (/^(www\.)?[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(s)) return "https://" + s;
  return null;
}

/** The whole run of text carrying the same link mark around pos. */
export function linkAt(state: EditorState, pos: number): { from: number; to: number; mark: Mark } | null {
  const $p = state.doc.resolve(pos);
  const mark = LINK.isInSet($p.marks()) || ($p.nodeAfter && LINK.isInSet($p.nodeAfter.marks)) || ($p.nodeBefore && LINK.isInSet($p.nodeBefore.marks));
  if (!mark) return null;
  const start = $p.start();
  let seg: { from: number; to: number } | null = null, hit: { from: number; to: number } | null = null;
  $p.parent.forEach((child, off) => {
    const a = start + off, b = a + child.nodeSize;
    if (mark.isInSet(child.marks)) { seg = seg && seg.to === a ? { from: seg.from, to: b } : { from: a, to: b }; if (seg.from <= pos && pos <= seg.to) hit = seg; }
    else seg = null;
  });
  return hit ? { ...(hit as { from: number; to: number }), mark } : null;
}

const el = (tag: string, cls: string, ...kids: (Node | string)[]) => { const e = document.createElement(tag); e.className = cls; e.append(...kids); return e; };

// ---------- dialog ----------
let dialog: HTMLElement | null = null;
const closeDialog = () => { dialog?.remove(); dialog = null; };

export function openLinkDialog(view: EditorView) {
  closeDialog();
  const { state } = view;
  const existing = linkAt(state, state.selection.from);
  const range = existing ?? { from: state.selection.from, to: state.selection.to };
  const oldText = state.doc.textBetween(range.from, range.to, " ");
  const text = Object.assign(document.createElement("input"), { value: oldText, placeholder: "Angezeigter Text" });
  const href = Object.assign(document.createElement("input"), { value: existing?.mark.attrs.href ?? "", placeholder: "https://… oder E-Mail-Adresse", type: "url" });
  const err = el("div", "lerr");
  const ok = el("button", "primary", "Übernehmen") as HTMLButtonElement;
  const remove = el("button", "", "Entfernen") as HTMLButtonElement;
  const cancel = el("button", "", "Abbrechen") as HTMLButtonElement;
  dialog = el("div", "lpop", el("label", "", "Text", text), el("label", "", "Adresse", href), err, el("div", "lrow", ...(existing ? [remove] : []), cancel, ok));
  document.body.append(dialog);
  const c = view.coordsAtPos(range.from);
  dialog.style.left = `${Math.min(c.left + window.scrollX, window.innerWidth - dialog.offsetWidth - 12)}px`;
  dialog.style.top = `${c.bottom + window.scrollY + 6}px`;
  (oldText ? href : text).focus();

  const apply = () => {
    const url = normalizeHref(href.value);
    if (!url) { err.textContent = "Bitte eine gültige Adresse (https://…, www.…, E-Mail) eingeben."; href.focus(); return; }
    const label = text.value || href.value.trim();
    const mark = LINK.create({ href: url });
    let tr = view.state.tr;
    if (label !== oldText || range.from === range.to) {
      tr = tr.insertText(label, range.from, range.to).addMark(range.from, range.from + label.length, mark);
      tr.setSelection(TextSelection.create(tr.doc, range.from + label.length));
    } else tr = tr.removeMark(range.from, range.to, LINK).addMark(range.from, range.to, mark);
    view.dispatch(tr.removeStoredMark(LINK).scrollIntoView());
    closeDialog(); view.focus();
  };
  ok.onclick = apply;
  remove.onclick = () => { view.dispatch(view.state.tr.removeMark(range.from, range.to, LINK)); closeDialog(); view.focus(); };
  cancel.onclick = () => { closeDialog(); view.focus(); };
  dialog.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } if (e.key === "Escape") { closeDialog(); view.focus(); } };
}

export const linkCommand: Command = (_state, dispatch, view) => { if (dispatch && view) openLinkDialog(view); return true; };

// ---------- plugin: bubble, autolink, paste, ctrl+click ----------
export function linkPlugin() {
  return new Plugin({
    view(view) {
      const bubble = el("div", "lbubble");
      bubble.hidden = true;
      document.body.append(bubble);
      const update = (v: EditorView) => {
        const { state } = v;
        const hit = v.hasFocus() && !dialog ? linkAt(state, state.selection.from) : null;
        if (!hit || state.selection.to > hit.to) { bubble.hidden = true; return; }
        const href = hit.mark.attrs.href as string;
        const a = Object.assign(document.createElement("a"), { href, target: "_blank", rel: "noopener noreferrer", textContent: href.replace(/^mailto:/, "").slice(0, 60) + (href.length > 60 ? "…" : "") });
        const edit = el("button", "", "Bearbeiten"), del = el("button", "", "Entfernen");
        edit.onmousedown = (e) => { e.preventDefault(); openLinkDialog(v); bubble.hidden = true; };
        del.onmousedown = (e) => { e.preventDefault(); v.dispatch(v.state.tr.removeMark(hit.from, hit.to, LINK)); };
        bubble.replaceChildren(a, edit, del);
        bubble.hidden = false;
        const c = v.coordsAtPos(hit.from);
        bubble.style.left = `${Math.min(c.left + window.scrollX, window.innerWidth - bubble.offsetWidth - 12)}px`;
        bubble.style.top = `${c.bottom + window.scrollY + 6}px`;
      };
      const hide = () => setTimeout(() => { if (!bubble.contains(document.activeElement)) bubble.hidden = true; }, 150);
      view.dom.addEventListener("blur", hide);
      return { update, destroy: () => { bubble.remove(); view.dom.removeEventListener("blur", hide); } };
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== " " || from !== to) return false;
        const $f = view.state.doc.resolve(from);
        const before = $f.parent.textBetween(Math.max(0, $f.parentOffset - 300), $f.parentOffset, undefined, "￼");
        const m = before.match(URLISH);
        if (!m) return false;
        const raw = m[0].replace(/[.,;:!?)\]]+$/, "");
        const start = from - m[0].length, end = start + raw.length;
        const href = normalizeHref(raw);
        if (!href || view.state.doc.rangeHasMark(start, end, LINK)) return false;
        view.dispatch(view.state.tr.addMark(start, end, LINK.create({ href })));
        return false; // let the space itself be typed as usual
      },
      handlePaste(view, event) {
        const { empty, from, to } = view.state.selection;
        const text = event.clipboardData?.getData("text/plain")?.trim() ?? "";
        const href = !empty && /^\S+$/.test(text) ? normalizeHref(text) : null;
        if (!href) return false;
        view.dispatch(view.state.tr.removeMark(from, to, LINK).addMark(from, to, LINK.create({ href })));
        return true;
      },
      handleClick(view, pos, event) {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const hit = linkAt(view.state, pos);
        if (!hit) return false;
        window.open(hit.mark.attrs.href, "_blank", "noopener,noreferrer");
        return true;
      },
    },
  });
}

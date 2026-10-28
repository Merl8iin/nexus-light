// Document schema: prosemirror-schema-basic + lists + tables, plus what an office needs on top:
// paragraph alignment, underline, strikethrough, font family/size/color and highlight.
// Node and mark names are what the worker reads and writes in the Yjs doc (src/markdown.ts).
import { Schema, type NodeSpec, type MarkSpec } from "prosemirror-model";
import { schema as basic } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { tableNodes } from "prosemirror-tables";

const align = { align: { default: null } };
const alignStyle = (a: string | null) => (a ? `text-align:${a}` : "");
const alignFrom = (dom: HTMLElement) => dom.style.textAlign || null;

let nodes = basic.spec.nodes
  .update("paragraph", {
    content: "inline*", group: "block", attrs: align,
    parseDOM: [{ tag: "p", getAttrs: (d) => ({ align: alignFrom(d as HTMLElement) }) }],
    toDOM: (n) => ["p", { style: alignStyle(n.attrs.align) }, 0],
  } as NodeSpec)
  .update("heading", {
    content: "inline*", group: "block", defining: true, attrs: { level: { default: 1 }, ...align },
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: "h" + level, getAttrs: (d: HTMLElement) => ({ level, align: alignFrom(d) }) })),
    toDOM: (n) => ["h" + n.attrs.level, { style: alignStyle(n.attrs.align) }, 0],
  } as NodeSpec);
// Images are blocks (own line) with a width in % and an alignment, like in a word processor.
nodes = nodes.update("image", {
  group: "block", atom: true, draggable: true,
  attrs: { src: {}, alt: { default: "" }, width: { default: null }, align: { default: "center" } },
  parseDOM: [{ tag: "img[src]", getAttrs: (d) => { const e = d as HTMLImageElement; return { src: e.getAttribute("src"), alt: e.alt || "", width: e.style.width || null, align: e.dataset.align || "center" }; } }],
  toDOM: (n) => ["img", { src: n.attrs.src, alt: n.attrs.alt, "data-align": n.attrs.align, style: n.attrs.width ? `width:${n.attrs.width}` : "" }],
} as NodeSpec);
nodes = addListNodes(nodes, "paragraph block*", "block");
nodes = nodes.append(tableNodes({
  tableGroup: "block", cellContent: "block+",
  cellAttributes: { background: { default: null, getFromDOM: (d) => (d as HTMLElement).style.backgroundColor || null, setDOMAttr: (v, a) => { if (v) a.style = `${a.style || ""}background-color:${v};`; } } },
}));

const marks = basic.spec.marks.append({
  underline: { parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }], toDOM: () => ["u", 0] } as MarkSpec,
  strike: { parseDOM: [{ tag: "s" }, { tag: "del" }, { style: "text-decoration=line-through" }], toDOM: () => ["s", 0] } as MarkSpec,
  textStyle: {
    attrs: { fontFamily: { default: null }, fontSize: { default: null }, color: { default: null } },
    parseDOM: [{ tag: "span[style]", getAttrs: (d) => { const s = (d as HTMLElement).style; return s.fontFamily || s.fontSize || s.color ? { fontFamily: s.fontFamily || null, fontSize: s.fontSize || null, color: s.color || null } : false; } }],
    toDOM: (m) => ["span", { style: [m.attrs.fontFamily && `font-family:${m.attrs.fontFamily}`, m.attrs.fontSize && `font-size:${m.attrs.fontSize}`, m.attrs.color && `color:${m.attrs.color}`].filter(Boolean).join(";") }, 0],
  } as MarkSpec,
  // A comment anchor: the thread itself lives in the Yjs map "comments" under this id. Several may overlap.
  comment: {
    attrs: { id: {} }, inclusive: false, excludes: "",
    parseDOM: [{ tag: "span[data-comment]", getAttrs: (d) => ({ id: (d as HTMLElement).dataset.comment }) }],
    toDOM: (m) => ["span", { "data-comment": m.attrs.id, class: "cmt" }, 0],
  } as MarkSpec,
  highlight: {
    attrs: { color: { default: "#fff59d" } },
    parseDOM: [{ tag: "mark", getAttrs: (d) => ({ color: (d as HTMLElement).style.backgroundColor || "#fff59d" }) }],
    toDOM: (m) => ["mark", { style: `background-color:${m.attrs.color}` }, 0],
  } as MarkSpec,
});

export const schema = new Schema({ nodes, marks });

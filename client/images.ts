// Images: insert by button, paste or drop. The browser shrinks them (max 1600 px, JPEG or PNG) before upload,
// so the worker never processes pixels; a small bar on a selected image sets width, alignment and alt text.
import { Plugin, NodeSelection, type Command } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { schema } from "./schema";
import { svg } from "./icons";

const IMG = schema.nodes.image;
const MAX_SIDE = 1600, MAX_BYTES = 1.9 * 1024 * 1024;
let docId = "", setStatus: (s: string) => void = () => {};
export function initImages(id: string, status: (s: string) => void) { docId = id; setStatus = status; }

async function shrink(file: File): Promise<Blob> {
  if (!/^image\/(png|jpeg|webp|gif|bmp|avif|heic|heif)$/.test(file.type)) throw new Error(`${file.name}: kein unterstütztes Bildformat`);
  if (file.type === "image/gif" && file.size <= MAX_BYTES) return file; // keep animation
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  // JPEG for photos, PNG when the image has transparency: both open in every Word version (WebP does not).
  const ctx = canvas.getContext("2d")!;
  const alpha = /png|webp|gif|avif/.test(file.type) && hasAlpha(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  for (let scale2 = 1; scale2 > 0.2; scale2 *= 0.75) {
    let c = canvas;
    if (scale2 < 1) { c = document.createElement("canvas"); c.width = Math.round(canvas.width * scale2); c.height = Math.round(canvas.height * scale2); c.getContext("2d")!.drawImage(canvas, 0, 0, c.width, c.height); }
    const blob = await new Promise<Blob | null>((r) => (alpha ? c.toBlob(r, "image/png") : c.toBlob(r, "image/jpeg", 0.85)));
    if (blob && blob.size <= MAX_BYTES) return blob;
  }
  throw new Error(`${file.name}: auch verkleinert noch zu groß`);
}

function hasAlpha(px: Uint8ClampedArray) {
  for (let i = 3; i < px.length; i += 4 * 7) if (px[i] < 250) return true; // sample every 7th pixel
  return false;
}

async function upload(blob: Blob): Promise<string> {
  const r = await fetch(`/d/${docId}/img`, { method: "POST", headers: { "content-type": blob.type }, body: blob });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || !j.url) throw new Error(j.error || `Upload fehlgeschlagen (${r.status})`);
  return j.url;
}

export async function insertImages(view: EditorView, files: File[], pos?: number) {
  for (const file of files) {
    try {
      setStatus(`Bild „${file.name}“ wird verkleinert …`);
      const blob = await shrink(file);
      setStatus(`Bild wird hochgeladen (${Math.ceil(blob.size / 1024)} KB) …`);
      const src = await upload(blob);
      const node = IMG.create({ src, alt: file.name.replace(/\.[^.]+$/, "") });
      const tr = pos == null ? view.state.tr.replaceSelectionWith(node) : view.state.tr.insert(view.state.doc.resolve(Math.min(pos, view.state.doc.content.size)).after(1) ?? pos, node);
      view.dispatch(tr.scrollIntoView());
      setStatus("");
    } catch (e) {
      setStatus("");
      alert((e as Error).message);
    }
  }
}

export const imageCommand: Command = (_s, dispatch, view) => {
  if (!dispatch || !view) return true;
  const input = Object.assign(document.createElement("input"), { type: "file", accept: "image/*", multiple: true });
  input.onchange = () => insertImages(view, [...(input.files ?? [])]);
  input.click();
  return true;
};

const imageFiles = (dt: DataTransfer | null) => [...(dt?.files ?? [])].filter((f) => f.type.startsWith("image/"));

export function imagePlugin() {
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const files = imageFiles(event.clipboardData);
        if (!files.length) return false;
        insertImages(view, files);
        return true;
      },
      handleDrop(view, event) {
        const files = imageFiles((event as DragEvent).dataTransfer);
        if (!files.length) return false;
        const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
        insertImages(view, files, at?.pos);
        return true;
      },
    },
    view() {
      const bar = document.createElement("div");
      bar.className = "lbubble imgbar";
      bar.hidden = true;
      document.body.append(bar);
      return {
        update(v) {
          const sel = v.state.selection;
          if (!(sel instanceof NodeSelection) || sel.node.type !== IMG) { bar.hidden = true; return; }
          const node = sel.node, pos = sel.from;
          const set = (attrs: Record<string, unknown>) => { const tr = v.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }); v.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos))); };
          const btn = (label: string | SVGElement, title: string, on: boolean, fn: () => void) => {
            const b = document.createElement("button");
            b.append(label); b.title = title; if (on) b.className = "on";
            b.onmousedown = (e) => { e.preventDefault(); fn(); };
            return b;
          };
          bar.replaceChildren(
            ...["25%", "50%", "75%", "100%"].map((w) => btn(w, `Breite ${w}`, (node.attrs.width ?? "100%") === w, () => set({ width: w === "100%" ? null : w }))),
            btn(svg("imgLeft"), "Links", node.attrs.align === "left", () => set({ align: "left" })),
            btn(svg("imgCenter"), "Mitte", node.attrs.align === "center", () => set({ align: "center" })),
            btn(svg("imgRight"), "Rechts", node.attrs.align === "right", () => set({ align: "right" })),
            btn("Alt-Text", "Bildbeschreibung (für Screenreader und die KI)", false, () => { const a = prompt("Bildbeschreibung:", node.attrs.alt); if (a != null) set({ alt: a }); }),
            btn("Löschen", "Bild löschen", false, () => v.dispatch(v.state.tr.delete(pos, pos + node.nodeSize))),
          );
          bar.hidden = false;
          const dom = v.nodeDOM(pos) as HTMLElement | null;
          const r = dom?.getBoundingClientRect();
          if (r) {
            bar.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - bar.offsetWidth / 2, window.innerWidth - bar.offsetWidth - 8)) + window.scrollX}px`;
            bar.style.top = `${Math.max(8, r.top + window.scrollY - bar.offsetHeight - 8)}px`;
          }
        },
        destroy() { bar.remove(); },
      };
    },
  });
}

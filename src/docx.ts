// Document tree (ProseMirror-shaped JSON) -> .docx. Covers what the editor can produce:
// headings, paragraphs with alignment, lists, quotes, code, rules, tables, images, links and
// bold/italic/underline/strike/code/font/size/color/highlight. Runs inside the DocRoom, not the worker.
import { zipSync, strToU8 } from "fflate";

export type PMNode = { type: string; attrs?: Record<string, any>; content?: PMNode[]; text?: string; marks?: { type: string; attrs?: Record<string, any> }[] };
export type ImageData = { data: Uint8Array; type: string };

const EMU_PER_PX = 9525;
const CONTENT_CM = 16; // A4 (21 cm) minus 2 × 2.5 cm margins
const CONTENT_EMU = CONTENT_CM * 360000;
const CONTENT_TWIPS = Math.round((CONTENT_CM / 2.54) * 1440);

const x = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

function hexColor(c: string | null | undefined) {
  if (!c) return null;
  const m = c.match(/^#?([0-9a-f]{6})$/i) || c.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m) return (m.length === 2 ? m[1] : m.slice(1).map((d) => d + d).join("")).toUpperCase();
  const rgb = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return rgb ? rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase() : null;
}

/** Pixel size from the image header (PNG, JPEG, GIF, WebP), without decoding the image. */
export function imageSize(d: Uint8Array): { w: number; h: number } | null {
  const u16 = (i: number) => (d[i] << 8) | d[i + 1], le16 = (i: number) => d[i] | (d[i + 1] << 8);
  const u32 = (i: number) => ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
  if (d[0] === 0x89 && d[1] === 0x50) return { w: u32(16), h: u32(20) };
  if (d[0] === 0x47 && d[1] === 0x49) return { w: le16(6), h: le16(8) };
  if (d[0] === 0xff && d[1] === 0xd8) {
    for (let i = 2; i + 9 < d.length;) {
      if (d[i] !== 0xff) { i++; continue; }
      const m = d[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: u16(i + 5), w: u16(i + 7) };
      i += 2 + u16(i + 2);
    }
    return null;
  }
  if (d[8] === 0x57 && d[9] === 0x45) {
    const f = String.fromCharCode(d[12], d[13], d[14], d[15]);
    if (f === "VP8X") return { w: 1 + (d[24] | (d[25] << 8) | (d[26] << 16)), h: 1 + (d[27] | (d[28] << 8) | (d[29] << 16)) };
    if (f === "VP8L") { const b = d[21] | (d[22] << 8) | (d[23] << 16) | (d[24] << 24); return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) }; }
    if (f === "VP8 ") return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
  }
  return null;
}

export function toDocx(title: string, doc: PMNode, images: Map<string, ImageData>): Uint8Array {
  const rels: string[] = [];
  const media: Record<string, Uint8Array> = {};
  const nums: string[] = [];
  let relId = 10, numId = 1, drawingId = 1;
  const linkRel = new Map<string, string>(), imgRel = new Map<string, string>();

  const rel = (type: string, target: string, external = false) => {
    const id = `rId${relId++}`;
    rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${x(target)}"${external ? ' TargetMode="External"' : ""}/>`);
    return id;
  };
  const newNum = (abstract: number) => { const id = ++numId; nums.push(`<w:num w:numId="${id}"><w:abstractNumId w:val="${abstract}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`); return id; };

  // ---- inline ----
  function runProps(marks: PMNode["marks"] = [], extra: { bold?: boolean; code?: boolean } = {}) {
    const has = (t: string) => marks.find((m) => m.type === t);
    const ts = has("textStyle")?.attrs ?? {};
    const font = has("code") || extra.code ? "Consolas" : ts.fontFamily ? String(ts.fontFamily).split(",")[0].replace(/['"]/g, "").trim() : null;
    const color = hexColor(ts.color);
    const size = ts.fontSize ? Math.round(parseFloat(ts.fontSize) * 2) : null;
    const hl = has("highlight") ? hexColor(has("highlight")!.attrs?.color) ?? "FFF59D" : null;
    let p = "";
    if (has("link")) p += `<w:rStyle w:val="Hyperlink"/>`;
    if (font) p += `<w:rFonts w:ascii="${x(font)}" w:hAnsi="${x(font)}" w:cs="${x(font)}"/>`;
    if (has("strong") || extra.bold) p += "<w:b/>";
    if (has("em")) p += "<w:i/>";
    if (has("strike")) p += "<w:strike/>";
    if (color) p += `<w:color w:val="${color}"/>`;
    if (size) p += `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`;
    if (has("underline") && !has("link")) p += `<w:u w:val="single"/>`;
    if (hl) p += `<w:shd w:val="clear" w:color="auto" w:fill="${hl}"/>`;
    return p ? `<w:rPr>${p}</w:rPr>` : "";
  }
  function run(n: PMNode, extra = {}) {
    if (n.type === "hard_break") return "<w:r><w:br/></w:r>";
    if (n.type !== "text" || !n.text) return "";
    return `<w:r>${runProps(n.marks, extra)}<w:t xml:space="preserve">${x(n.text)}</w:t></w:r>`;
  }
  function inline(nodes: PMNode[] = [], extra = {}) {
    let out = "", i = 0;
    while (i < nodes.length) {
      const href = nodes[i].marks?.find((m) => m.type === "link")?.attrs?.href as string | undefined;
      if (!href) { out += run(nodes[i++], extra); continue; }
      let group = "";
      while (i < nodes.length && nodes[i].marks?.find((m) => m.type === "link")?.attrs?.href === href) group += run(nodes[i++], extra);
      if (!linkRel.has(href)) linkRel.set(href, rel("hyperlink", href, true));
      out += `<w:hyperlink r:id="${linkRel.get(href)}" w:history="1">${group}</w:hyperlink>`;
    }
    return out;
  }

  // ---- blocks ----
  type Ctx = { style?: string; num?: { id: number; level: number }; bold?: boolean };
  const JC: Record<string, string> = { left: "left", center: "center", right: "right", justify: "both" };
  function para(n: PMNode, ctx: Ctx, extra = "") {
    let pPr = "";
    if (ctx.style) pPr += `<w:pStyle w:val="${ctx.style}"/>`;
    if (ctx.num) pPr += `<w:numPr><w:ilvl w:val="${ctx.num.level}"/><w:numId w:val="${ctx.num.id}"/></w:numPr>`;
    pPr += extra;
    const jc = JC[n.attrs?.align ?? ""];
    if (jc && jc !== "left") pPr += `<w:jc w:val="${jc}"/>`;
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inline(n.content, { bold: ctx.bold })}</w:p>`;
  }

  function image(n: PMNode) {
    const src = String(n.attrs?.src ?? "");
    const img = images.get(src);
    if (!img) return `<w:p>${inline([{ type: "text", text: `[Bild: ${n.attrs?.alt || src}]`, marks: src.startsWith("http") ? [{ type: "link", attrs: { href: src } }] : [] }])}</w:p>`;
    const size = imageSize(img.data) ?? { w: 800, h: 600 };
    const pct = n.attrs?.width ? parseFloat(n.attrs.width) / 100 : null;
    const cx = Math.round(pct ? CONTENT_EMU * pct : Math.min(CONTENT_EMU, size.w * EMU_PER_PX));
    const cy = Math.round((cx * size.h) / size.w);
    if (!imgRel.has(src)) {
      const ext = img.type.split("/")[1].replace("jpeg", "jpg");
      const name = `image${imgRel.size + 1}.${ext}`;
      media[`word/media/${name}`] = img.data;
      imgRel.set(src, rel("image", `media/${name}`));
    }
    const id = drawingId++, alt = x(String(n.attrs?.alt ?? ""));
    const jc = JC[n.attrs?.align ?? "center"] ?? "center";
    return `<w:p><w:pPr><w:jc w:val="${jc}"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Bild ${id}" descr="${alt}"/>`
      + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
      + `<pic:nvPicPr><pic:cNvPr id="${id}" name="Bild ${id}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${imgRel.get(src)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  }

  function table(n: PMNode) {
    const rows = n.content ?? [];
    const cols = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((s, c) => s + (c.attrs?.colspan ?? 1), 0)));
    const w = Math.floor(CONTENT_TWIPS / cols);
    let out = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${w}"/>`.repeat(cols)}</w:tblGrid>`;
    for (const r of rows) {
      out += "<w:tr>";
      for (const c of r.content ?? []) {
        const head = c.type === "table_header", span = c.attrs?.colspan ?? 1;
        const bg = hexColor(c.attrs?.background) ?? (head ? "F1F3F6" : null);
        const body = blocks(c.content ?? [], { bold: head });
        out += `<w:tc><w:tcPr><w:tcW w:w="${w * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}${bg ? `<w:shd w:val="clear" w:color="auto" w:fill="${bg}"/>` : ""}</w:tcPr>${body.endsWith("</w:p>") ? body : body + "<w:p/>"}</w:tc>`;
      }
      out += "</w:tr>";
    }
    return out + "</w:tbl>";
  }

  function blocks(nodes: PMNode[], ctx: Ctx = {}): string {
    let out = "";
    for (const n of nodes) {
      switch (n.type) {
        case "paragraph": out += para(n, ctx); break;
        case "heading": out += para(n, { ...ctx, style: `Heading${Math.min(3, n.attrs?.level ?? 1)}` }); break;
        case "blockquote": out += blocks(n.content ?? [], { ...ctx, style: "Quote" }); break;
        case "code_block": {
          const lines = (n.content ?? []).map((t) => t.text ?? "").join("").split("\n");
          for (const l of lines) out += `<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr>${run({ type: "text", text: l }, { code: true })}</w:p>`;
          break;
        }
        case "horizontal_rule": out += `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C9CED6"/></w:pBdr></w:pPr></w:p>`; break;
        case "bullet_list": case "ordered_list": {
          const id = n.type === "bullet_list" ? 1 : newNum(2);
          const level = ctx.num ? ctx.num.level + 1 : 0;
          for (const li of n.content ?? []) out += blocks(li.content ?? [], { ...ctx, num: { id, level: Math.min(level, 8) } });
          break;
        }
        case "table": out += table(n); break;
        case "image": out += image(n); break;
        default: if (n.content) out += blocks(n.content, ctx);
      }
    }
    return out;
  }

  let body = blocks(doc.content ?? []);
  if (!body || body.endsWith("</w:tbl>")) body += "<w:p/>";

  const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1134" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const lvl = (i: number, fmt: string, text: string, font?: string) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + i * 360}" w:hanging="360"/></w:pPr>${font ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr>` : ""}</w:lvl>`;
  const bullets = ["•", "◦", "▪"];
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${Array.from({ length: 9 }, (_, i) => lvl(i, "bullet", bullets[i % 3])).join("")}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="hybridMultilevel"/>${Array.from({ length: 9 }, (_, i) => lvl(i, ["decimal", "lowerLetter", "lowerRoman"][i % 3], `%${i + 1}.`)).join("")}</w:abstractNum>`
    + `<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>${nums.join("")}</w:numbering>`;

  const heading = (id: string, name: string, size: number, color = "2F5496") => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="80"/><w:outlineLvl w:val="${Number(id.slice(-1)) - 1}"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`
    + heading("Heading1", "heading 1", 40) + heading("Heading2", "heading 2", 30) + heading("Heading3", "heading 3", 25, "1F3763")
    + `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="C9CED6"/></w:pBdr><w:ind w:left="340"/></w:pPr><w:rPr><w:i/><w:color w:val="404650"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F4F5F7"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>`
    + `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>`
    + `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFC4CC"/>`).join("")}</w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr><w:pPr><w:spacing w:after="0"/></w:pPr></w:style>`
    + `</w:styles>`;

  const ctypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="webp" ContentType="image/webp"/>`
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    "[Content_Types].xml": strToU8(ctypes),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    "docProps/core.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(title)}</dc:title><dc:creator>Nexus Light</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`),
    "word/document.xml": strToU8(documentXml),
    "word/styles.xml": strToU8(styles),
    "word/numbering.xml": strToU8(numbering),
    "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${rels.join("")}</Relationships>`),
  };
  // Images are already compressed: store them as-is instead of spending CPU on deflate.
  for (const [path, data] of Object.entries(media)) files[path] = [data, { level: 0 }];
  return zipSync(files as any, { level: 6 });
}

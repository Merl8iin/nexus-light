// Tiny markdown <-> Yjs block bridge, so agents read and write documents as markdown.
// Covers what the editor offers: headings, paragraphs, lists, quotes, code, rules; **bold**, *italic*, `code`, [links](url).
import * as Y from "yjs";

export type Run = { text: string; marks: Record<string, unknown> };
export type Block = {
  type: "paragraph" | "heading" | "bullet_list" | "ordered_list" | "blockquote" | "code_block" | "horizontal_rule" | "table" | "image";
  level?: number;
  align?: string;
  text: Run[];
  items?: Run[][];
  /** Image source and description (type "image"). */
  src?: string;
  alt?: string;
  /** Table rows of cells; the first row is the header. */
  rows?: Run[][][];
};

const INLINE = /\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|`(.+?)`|\[([^\]]+)\]\(([^)\s]+)\)|~~(.+?)~~|==(.+?)==|<u>(.+?)<\/u>/g;

export function parseInline(s: string, base: Record<string, unknown> = {}): Run[] {
  const runs: Run[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index! > last) runs.push({ text: s.slice(last, m.index), marks: { ...base } });
    if (m[1] ?? m[2]) runs.push(...parseInline(m[1] ?? m[2], { ...base, strong: {} }));
    else if (m[3] ?? m[4]) runs.push(...parseInline(m[3] ?? m[4], { ...base, em: {} }));
    else if (m[5]) runs.push({ text: m[5], marks: { ...base, code: {} } });
    else if (m[6]) runs.push(...parseInline(m[6], { ...base, link: { href: m[7], title: null } }));
    else if (m[8]) runs.push(...parseInline(m[8], { ...base, strike: {} }));
    else if (m[9]) runs.push(...parseInline(m[9], { ...base, highlight: { color: "#fff59d" } }));
    else runs.push(...parseInline(m[10], { ...base, underline: {} }));
    last = m.index! + m[0].length;
  }
  if (last < s.length) runs.push({ text: s.slice(last), marks: { ...base } });
  return runs.filter((r) => r.text);
}

export function blocksFromMarkdown(md: string): Block[] {
  const lines = md.replace(/\r/g, "").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ type: "paragraph", text: parseInline(para.join(" ")) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;
    if (!line.trim()) { flush(); continue; }
    if (line.startsWith("```")) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) code.push(lines[i]);
      out.push({ type: "code_block", text: [{ text: code.join("\n"), marks: {} }] });
    } else if ((m = line.trim().match(/^!\[([^\]]*)\]\((\S+?)\)$/)) && /^(https:\/\/|\/d\/)/.test(m[2])) {
      flush(); out.push({ type: "image", text: [], src: m[2], alt: m[1] });
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows: Run[][][] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue; // the --- separator row
        rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => parseInline(c.trim())));
      }
      i--;
      out.push({ type: "table", text: [], rows });
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flush(); out.push({ type: "heading", level: m[1].length, text: parseInline(m[2]) });
    } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      flush(); out.push({ type: "horizontal_rule", text: [] });
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flush();
      const type = /^\s*\d/.test(line) ? "ordered_list" : "bullet_list";
      const prev = out[out.length - 1];
      if (prev?.type === type) prev.items!.push(parseInline(m[1]));
      else out.push({ type, text: [], items: [parseInline(m[1])] });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flush(); out.push({ type: "blockquote", text: parseInline(m[1]) });
    } else para.push(line.trim());
  }
  flush();
  return out.length ? out : [{ type: "paragraph", text: [] }];
}

function inlineToMarkdown(t: Y.XmlText) {
  return (t.toDelta() as { insert: unknown; attributes?: Record<string, any> }[]).map((d) => {
    if (typeof d.insert !== "string") return "";
    let s = d.insert;
    const a = d.attributes ?? {};
    if (a.code) s = "`" + s + "`";
    if (a.em) s = `*${s}*`;
    if (a.strong) s = `**${s}**`;
    if (a.strike) s = `~~${s}~~`;
    if (a.underline) s = `<u>${s}</u>`;
    if (a.highlight) s = `==${s}==`;
    if (a.link) s = `[${s}](${a.link.href})`;
    return s;
  }).join("");
}

function textOf(el: Y.XmlElement): string {
  return el.toArray().map((c) => (c instanceof Y.XmlText ? inlineToMarkdown(c) : c instanceof Y.XmlElement ? textOf(c) : "")).join("");
}

export function blockToMarkdown(el: Y.XmlElement): string {
  switch (el.nodeName) {
    case "heading": return "#".repeat(Number(el.getAttribute("level")) || 1) + " " + textOf(el);
    case "bullet_list": return el.toArray().map((li) => "- " + textOf(li as Y.XmlElement)).join("\n");
    case "ordered_list": return el.toArray().map((li, i) => `${i + 1}. ` + textOf(li as Y.XmlElement)).join("\n");
    case "blockquote": return "> " + textOf(el);
    case "code_block": return "```\n" + el.toArray().map((c) => (c instanceof Y.XmlText ? c.toString() : "")).join("") + "\n```";
    case "horizontal_rule": return "---";
    case "image": return `![${el.getAttribute("alt") ?? ""}](${el.getAttribute("src")})`;
    case "table": {
      const rows = el.toArray().map((r) => (r as Y.XmlElement).toArray().map((c) => textOf(c as Y.XmlElement).replace(/\|/g, "\\|")));
      if (!rows.length) return "";
      const head = `| ${rows[0].join(" | ")} |\n|${rows[0].map(() => " --- ").join("|")}|`;
      return [head, ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`)].join("\n");
    }
    default: return textOf(el);
  }
}

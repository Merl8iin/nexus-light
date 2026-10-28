// Stroke icons (24×24 paths) for the ribbon and the small bars.
export const ICON: Record<string, string> = {
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  redo: "m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  left: "M21 6H3M15 12H3M17 18H3", center: "M21 6H3M17 12H7M19 18H5", right: "M21 6H3M21 12H9M21 18H7", justify: "M21 6H3M21 12H3M21 18H3",
  bullet: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01", ordered: "M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1",
  indent: "m3 8 4 4-4 4M21 12H11M21 6H11M21 18H11", outdent: "m7 8-4 4 4 4M21 12H11M21 6H11M21 18H11",
  quote: "M3 21c3 0 7-1 7-8V5H3v7h4c0 3.5-2 5-4 5zM14 21c3 0 7-1 7-8V5h-7v7h4c0 3.5-2 5-4 5z",
  table: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18", link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  imgLeft: "M3 5h8v8H3zM15 7h6M15 11h6M3 17h18", imgCenter: "M8 5h8v8H8zM3 17h18", imgRight: "M13 5h8v8h-8zM3 7h6M3 11h6M3 17h18",
  comment: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM8 9h8M8 13h5",
  rule: "M3 12h18", image: "M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21", highlight: "m9 11-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4", clear: "M4 7V4h16v3M9 20h6M12 4v16M3 3l18 18",
  rowAdd: "M3 3h18v8H3zM12 15v6M9 18h6", colAdd: "M3 3h8v18H3zM15 12h6M18 9v6", rowDel: "M3 3h18v8H3zM9 18h6", colDel: "M3 3h8v18H3zM15 12h6", tableDel: "M3 3h18v18H3zM9 9l6 6M15 9l-6 6",
};
export const svg = (name: string) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.innerHTML = `<path d="${ICON[name]}"/>`; return s; };

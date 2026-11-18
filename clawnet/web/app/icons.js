/**
 * The app's icons: Lucide (https://lucide.dev, ISC licence), fetched from Iconify by the
 * tastemaker design workflow and kept here as geometry only. They are drawn with
 * stroke="currentColor", so CSS colours them, and built with createElementNS, never
 * innerHTML. With thanks to the Lucide contributors.
 */

const SHAPES = Object.freeze({
  "check": [["path",{"d":"M20 6L9 17l-5-5"}]],
  "check-check": [["path",{"d":"M18 6L7 17l-5-5m20-2l-7.5 7.5L13 16"}]],
  "chevron-left": [["path",{"d":"m15 18l-6-6l6-6"}]],
  "chevron-right": [["path",{"d":"m9 18l6-6l-6-6"}]],
  "circle-alert": [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 8v4m0 4h.01"}]],
  "clock": [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6l4 2"}]],
  "copy": [["rect",{"width":"14","height":"14","x":"8","y":"8","rx":"2","ry":"2"}],["path",{"d":"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]],
  "link": [["path",{"d":"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"}],["path",{"d":"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"}]],
  "pencil": [["path",{"d":"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4"}]],
  "refresh-cw": [["path",{"d":"M3 12a9 9 0 0 1 9-9a9.75 9.75 0 0 1 6.74 2.74L21 8"}],["path",{"d":"M21 3v5h-5m5 4a9 9 0 0 1-9 9a9.75 9.75 0 0 1-6.74-2.74L3 16"}],["path",{"d":"M8 16H3v5"}]],
  "send": [["path",{"d":"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11zm7.318-19.539l-10.94 10.939"}]],
  "share": [["path",{"d":"M12 2v13m4-9l-4-4l-4 4m-4 6v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"}]],
  "x": [["path",{"d":"M18 6L6 18M6 6l12 12"}]],
});

const NS = 'http://www.w3.org/2000/svg';

/**
 * @param {keyof typeof SHAPES} name
 * @param {{ size?: number, label?: string }} [options] a label makes the icon meaningful to
 *   screen readers; without one it is hidden from them
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = 20, label } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'icon');
  if (label === undefined) svg.setAttribute('aria-hidden', 'true');
  else {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  }
  for (const [tag, attrs] of SHAPES[name] ?? []) {
    const shape = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}

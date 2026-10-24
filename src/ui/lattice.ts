import type { Directive, DirectiveBinding } from "vue";

const SVG_NS = "http://www.w3.org/2000/svg";
const sizes = [4, 8, 14, 8, 4];
const positions = [3, 11, 24, 43, 55];

function corner(inset: boolean, end: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("lattice-corner");
  if (end) svg.classList.add("lattice-end");

  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("fill", "none");
  group.setAttribute("stroke", "currentColor");
  group.setAttribute("stroke-width", "1");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M1 63V1H63");
  group.appendChild(path);

  // 左臂由下向上，顶臂由左向右；旋转后的右下角接续顺时针次序。
  const indices = inset ? [1, 2, 3] : [0, 1, 2, 3, 4];
  let step = end ? indices.length * 2 : 0;
  for (const side of [true, false]) {
    for (const index of side ? [...indices].reverse() : indices) {
      const size = sizes[index];
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(side ? (inset ? 1 : 1 - size) : positions[index]));
      rect.setAttribute("y", String(side ? positions[index] : (inset ? 1 : 1 - size)));
      rect.setAttribute("width", String(size));
      rect.setAttribute("height", String(size));
      if (side) rect.classList.add("lattice-side");
      rect.style.setProperty("--step", String(step++));
      group.appendChild(rect);
    }
  }
  svg.appendChild(group);
  return svg;
}

function decorate(el: HTMLElement, binding: DirectiveBinding) {
  const button = !binding.arg || binding.arg === "icon";
  el.classList.add(button ? "lattice-button" : "lattice-frame");
  el.classList.toggle("lattice-icon", binding.arg === "icon");
  for (const level of ["one", "two", "three"]) {
    el.classList.toggle(`lattice-layer-${level}`, binding.arg === level);
  }
  // Vue 更新纯文字按钮时会替换 textContent，因此在 updated 中补回角花。
  if (!Array.from(el.children).some(child => child.classList.contains("lattice-corner"))) {
    el.appendChild(corner(button, false));
    el.appendChild(corner(button, true));
  }
}

export const lattice: Directive<HTMLElement> = {
  mounted: decorate,
  updated: decorate,
};

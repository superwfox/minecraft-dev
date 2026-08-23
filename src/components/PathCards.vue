<template>
  <div class="path-cards">
    <div class="pc-head">
      <div class="pc-level">复杂度：{{ level }}</div>
      <div class="pc-title">选择实现路径</div>
      <div class="pc-sub">
        向下拖动选择 · 聚焦卡片按 <kbd>Space</kbd> 放大预览流程图 · ← → 切换
      </div>
    </div>

    <div class="pc-hints" v-show="drag">
      <div class="pc-hint" :class="{ on: drag && drag.zone === 'select' }">
        <span class="ar">↓</span>选择此方案
      </div>
    </div>

    <canvas class="pc-fx" ref="fxRef"></canvas>

    <div class="pc-stage" ref="stageRef">
      <div
        v-for="c in cards"
        v-show="!c.gone"
        :key="c.id"
        class="pc-card"
        :class="{ grabbing: drag && drag.id === c.id }"
        :style="outerStyle(c)"
      >
        <div
          class="pc-card-inner"
          :class="{ active: activeId === c.id, grabbing: drag && drag.id === c.id }"
          :style="innerStyle(c)"
          @pointerdown="startDrag($event, c)"
        >
          <svg class="pc-dots" :viewBox="`0 0 ${baseW} ${baseH}`" preserveAspectRatio="xMidYMid meet">
            <rect :x="6" :y="6" :width="baseW - 12" :height="baseH - 12" rx="14" ry="14"
                  fill="none" :stroke="dotColor(c)" stroke-width="3" stroke-linecap="round" pathLength="792" stroke-dasharray="0.01 10.99"/>
          </svg>
          <div class="pc-card-title">{{ c.title }}</div>
          <div class="pc-card-summary">{{ c.summary }}</div>
          <div class="pc-card-hint">Space 预览流程图</div>
        </div>
      </div>
    </div>

    <!-- mermaid 全屏预览：可拖动 + 缩放 -->
    <div v-if="previewOpen" class="pc-preview" @click.self="closePreview">
      <div class="pc-preview-box">
        <div class="pc-preview-head">
          <span class="pc-preview-name">{{ previewTitle }}</span>
          <div class="pc-preview-tools">
            <button class="pc-tool" @click="zoomBtn(-1)" title="缩小">－</button>
            <button class="pc-tool" @click="fitView" title="适应窗口">适应</button>
            <button class="pc-tool" @click="zoomBtn(1)" title="放大">＋</button>
            <button class="pc-tool close" @click="closePreview" title="关闭">×</button>
          </div>
        </div>
        <div class="pc-preview-canvas" ref="pvCanvas"
             :class="{ grabbing: pvDragging }"
             @pointerdown="pvDown" @wheel.prevent="pvWheel">
          <div class="pc-preview-content" :style="pvStyle" v-html="previewSvg"></div>
        </div>
        <div class="pc-preview-hint">双指/滚轮平移 · 捏合或 Ctrl/⌘ + 滚轮缩放 · 按住拖动平移 · Esc 关闭</div>
      </div>
    </div>

    <!-- 打回修正 -->
    <div v-if="rejectOpen" class="pc-reject">
      <input ref="rejectInput" v-model="rejectText" class="pc-reject-input"
             placeholder="说明哪里理解错了，AI 重新分析…"
             @compositionstart="onImeCompositionStart"
             @compositionend="onImeCompositionEnd"
             @keydown.enter="onRejectEnter"
             @keydown.esc.stop.prevent="rejectOpen = false"/>
      <button class="pc-btn primary" :disabled="!rejectText.trim()" @click="confirmReject">重画</button>
      <button class="pc-btn ghost" @click="rejectOpen = false">取消</button>
    </div>

    <div class="pc-foot">
      <button class="pc-nav" @click="focusPrev" :disabled="!cards.length" title="上一张 (←)">‹</button>
      <button class="pc-btn ghost" @click="activeCard && openPreview(activeCard)" :disabled="!activeCard">预览流程图</button>
      <span class="pc-foot-spacer"></span>
      <button class="pc-btn ghost" @click="openReject">都不符合 · 修正重画</button>
      <button class="pc-nav" @click="focusNext" :disabled="!cards.length" title="下一张 (→)">›</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";
import { genTask, submitPathChoice, submitPathReject } from "../logic/generateState";
import type { GradePath } from "../logic/generateState";
import {isImeComposing, onImeCompositionEnd, onImeCompositionStart} from "../logic/keyboard";

type CardKind = {
    id: string;
    title: string;
    summary: string;
    mermaid: string;
    color: string;
    exiting: null | "chosen";
    entering: boolean;
    gone: boolean;
    relX: number;
    relY: number;
};

const palette: Record<string, { bg: string; text: string; dot: string }> = {
    cream:  { bg: "#d1c8b6", text: "#040402", dot: "rgba(4,4,2,.28)"       },
    wheat:  { bg: "#c6b07d", text: "#040402", dot: "rgba(4,4,2,.34)"       },
    orange: { bg: "#423725", text: "#f4f1ec", dot: "rgba(213,201,172,.4)"  },
    brown:  { bg: "#262626", text: "#d1c8b6", dot: "rgba(209,200,182,.3)"  },
    cocoa:  { bg: "#090907", text: "#d1c8b6", dot: "rgba(209,200,182,.34)" },
};
const colorKeys = ["wheat", "orange", "cream", "brown", "cocoa"];

const baseW = 200, baseH = 284;

const level = computed(() => genTask.grade?.level || "");
const cards = ref<CardKind[]>([]);

function buildCards() {
    const paths: GradePath[] = genTask.grade?.paths ?? [];
    cards.value = paths.map((p, i) => ({
        id: p.id || `p${i}`, title: p.title, summary: p.summary, mermaid: p.mermaid,
        color: colorKeys[i % colorKeys.length],
        exiting: null, entering: true, gone: false, relX: 0, relY: 0,
    }));
    requestAnimationFrame(() => requestAnimationFrame(() => {
        cards.value.forEach(c => { c.entering = false; });
    }));
}

// ── 扇形布局 ──
const laidOut = computed(() => cards.value.filter(c => !c.gone && !c.exiting));
const n = computed(() => laidOut.value.length);
const globalScale = computed(() => Math.max(0.66, Math.min(1.0, 1.0 - (n.value - 3) * 0.06)));
const step = computed(() => baseW * globalScale.value * 0.62);

const slots = computed(() => {
    const cnt = n.value, mid = (cnt - 1) / 2;
    const spread = Math.min(7, 22 / Math.max(cnt, 1));
    const map: Record<string, { x: number; rot: number; arc: number; idx: number }> = {};
    laidOut.value.forEach((c, idx) => {
        const d = idx - mid;
        map[c.id] = { x: d * step.value, rot: d * spread, arc: d * d * 2.0, idx };
    });
    return map;
});

const activeId = ref<string | null>(null);
const activeCard = computed(() => cards.value.find(c => c.id === activeId.value) || null);
const stageRef = ref<HTMLElement | null>(null);
const drag = ref<any>(null);

function geom(card: CardKind) {
    const gs = globalScale.value, bs = gs;
    if (drag.value && drag.value.id === card.id) {
        const d = drag.value;
        return { x: d.baseX + d.dx, y: d.baseY + d.dy, rot: 0, scale: bs * 1.16, opacity: 1, z: 1000 };
    }
    if (card.exiting === "chosen") return { x: 0, y: 250, rot: 0, scale: bs * 0.5, opacity: 0, z: 990 };
    const slot = slots.value[card.id];
    if (!slot) return null;
    if (card.entering) return { x: slot.x, y: slot.arc + 200, rot: 0, scale: bs * 0.6, opacity: 0, z: 60 };
    const active = activeId.value === card.id;
    let rot = slot.rot, y = slot.arc, scale = bs, z = slot.idx + 1;
    if (active) { rot = 0; y = slot.arc - 50; scale = bs * 1.16; z = 100; }
    return { x: slot.x, y, rot, scale, opacity: 1, z };
}
function outerStyle(card: CardKind) {
    const g = geom(card); if (!g) return { display: "none" };
    return { width: baseW + "px", height: baseH + "px", zIndex: g.z, opacity: g.opacity,
        transform: `translate(-50%,-50%) translate(${g.x}px, ${g.y}px)` };
}
function innerStyle(card: CardKind) {
    const g = geom(card); if (!g) return {};
    return { background: palette[card.color].bg, color: palette[card.color].text,
        transform: `rotate(${g.rot}deg) scale(${g.scale})` };
}
const dotColor = (card: CardKind) => palette[card.color].dot;

// ── 悬停 / 方向键聚焦 ──
function onMove(e: MouseEvent) {
    if (drag.value || previewOpen.value || rejectOpen.value) return;
    const el = stageRef.value; if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = e.clientX - (r.left + r.width / 2), cy = e.clientY - (r.top + r.height / 2);
    if (Math.abs(cy) > baseH * globalScale.value * 0.5 + 100) { activeId.value = null; return; }
    let bestId: string | null = null, bestDist = Infinity;
    for (const c of laidOut.value) {
        const dist = Math.abs(cx - slots.value[c.id].x);
        if (dist < bestDist) { bestDist = dist; bestId = c.id; }
    }
    activeId.value = bestDist <= step.value + baseW * globalScale.value * 0.5 ? bestId : null;
}
function focusBy(delta: number) {
    const list = laidOut.value;
    if (!list.length) return;
    let i = list.findIndex(c => c.id === activeId.value);
    if (i < 0) i = delta > 0 ? -1 : 0;
    i = (i + delta + list.length) % list.length;
    activeId.value = list[i].id;
}
const focusPrev = () => focusBy(-1);
const focusNext = () => focusBy(1);

// ── 拖拽选择 ──
function zoneFor(y: number): "select" | "none" {
    return y > window.innerHeight * 0.72 ? "select" : "none";
}
function startDrag(e: PointerEvent, card: CardKind) {
    if (e.button !== 0 || card.exiting) return;
    e.preventDefault();
    const g = geom(card); if (!g) return;
    const sc = globalScale.value * 1.16;
    drag.value = {
        id: card.id, startX: e.clientX, startY: e.clientY,
        baseX: g.x, baseY: g.y, dx: 0, dy: 0, zone: "none",
        halfW: baseW * sc / 2, halfH: baseH * sc / 2, color: palette[card.color].bg,
    };
    activeId.value = null;
    window.addEventListener("pointermove", onDrag);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
}
function onDrag(e: PointerEvent) {
    const d = drag.value; if (!d) return;
    d.dx = e.clientX - d.startX;
    d.dy = e.clientY - d.startY;
    d.zone = zoneFor(e.clientY);
}
function endDrag() {
    const d = drag.value; if (!d) return;
    window.removeEventListener("pointermove", onDrag);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    const card = cards.value.find(c => c.id === d.id);
    const zone = d.zone;
    if (card) { card.relX = d.baseX + d.dx; card.relY = d.baseY + d.dy; }
    drag.value = null;
    if (!card || zone !== "select") return;
    submitPathChoice(card.id); // 选定 → 解阻塞，generateHandler 进入全量 plan
}

// ── mermaid 全屏预览 ──
const previewOpen = ref(false);
const previewTitle = ref("");
const previewSvg = ref("");
let mermaidMod: any = null;
async function ensureMermaid() {
    if (mermaidMod) return mermaidMod;
    const m = (await import("mermaid")).default;
    m.initialize({
        startOnLoad: false, theme: "dark", securityLevel: "strict",
        // Mermaid 11 的通用节点渲染器读取顶层配置；否则会生成随后被安全清理移除的 foreignObject 标签。
        htmlLabels: false,
        flowchart: { useMaxWidth: false, htmlLabels: false, curve: "basis" },
    });
    mermaidMod = m;
    return m;
}
function escapeHtml(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function sanitizeMermaidSvg(svg: string): string {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (doc.querySelector("parsererror")) throw new Error("Invalid Mermaid SVG");

    doc.querySelectorAll("script, foreignObject, iframe, object, embed, link, meta").forEach((node) => node.remove());
    doc.querySelectorAll("*").forEach((node) => {
        for (const attr of Array.from(node.attributes)) {
            const name = attr.name.toLowerCase();
            const value = attr.value.trim();
            if (name.startsWith("on")) {
                node.removeAttribute(attr.name);
                continue;
            }
            if ((name === "href" || name === "xlink:href" || name === "src") && !value.startsWith("#")) {
                node.removeAttribute(attr.name);
                continue;
            }
            if (name === "style" && /url\s*\(\s*['\"]?\s*(?:javascript:|https?:|data:text\/html)/i.test(value)) {
                node.removeAttribute(attr.name);
            }
        }
    });
    return doc.documentElement.outerHTML;
}
async function openPreview(card: CardKind | null) {
    if (!card) return;
    previewTitle.value = card.title;
    previewSvg.value = "<div class='pc-preview-loading'>渲染中…</div>";
    pvScale.value = 1; pvX.value = 0; pvY.value = 0;
    previewOpen.value = true;
    try {
        const m = await ensureMermaid();
        const { svg } = await m.render("pcmmd-" + Math.random().toString(36).slice(2), card.mermaid);
        if (previewOpen.value) {
            previewSvg.value = sanitizeMermaidSvg(svg);
            await nextTick();
            fitView();
        }
    } catch {
        previewSvg.value = "<pre class='pc-preview-err'>流程图渲染失败，原始定义：\n" + escapeHtml(card.mermaid) + "</pre>";
    }
}
function closePreview() { previewOpen.value = false; }

// ── 预览画布：拖动平移 + 滚轮/按钮缩放（transform-origin 0 0）──
const pvCanvas = ref<HTMLElement | null>(null);
const pvScale = ref(1);
const pvX = ref(0);
const pvY = ref(0);
const pvDragging = ref(false);
const pvStyle = computed(() => ({ transform: `translate(${pvX.value}px, ${pvY.value}px) scale(${pvScale.value})` }));
const clampScale = (s: number) => Math.min(6, Math.max(0.15, s));

let pvDrag: { x: number; y: number; ox: number; oy: number } | null = null;
function pvDown(e: PointerEvent) {
    if (e.button !== 0) return;
    pvDrag = { x: e.clientX, y: e.clientY, ox: pvX.value, oy: pvY.value };
    pvDragging.value = true;
    window.addEventListener("pointermove", pvMove);
    window.addEventListener("pointerup", pvUp);
}
function pvMove(e: PointerEvent) {
    if (!pvDrag) return;
    pvX.value = pvDrag.ox + (e.clientX - pvDrag.x);
    pvY.value = pvDrag.oy + (e.clientY - pvDrag.y);
}
function pvUp() {
    pvDrag = null;
    pvDragging.value = false;
    window.removeEventListener("pointermove", pvMove);
    window.removeEventListener("pointerup", pvUp);
}
// 围绕某画布坐标点缩放，保持该点不动
function zoomAt(cx: number, cy: number, factor: number) {
    const ns = clampScale(pvScale.value * factor);
    pvX.value = cx - (cx - pvX.value) * (ns / pvScale.value);
    pvY.value = cy - (cy - pvY.value) * (ns / pvScale.value);
    pvScale.value = ns;
}
function pvWheel(e: WheelEvent) {
    const canvas = pvCanvas.value;
    if (!canvas) return;

    // 触控板双指滑动和鼠标滚轮都会产生 wheel 事件；默认用于平移。
    // 触控板捏合在 Chromium/Safari 中会带 ctrlKey，键盘修饰滚轮也沿用缩放。
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (!e.ctrlKey && !e.metaKey) {
        pvX.value -= dx;
        pvY.value -= dy;
        return;
    }

    const r = canvas.getBoundingClientRect();
    const limitedDelta = Math.max(-60, Math.min(60, dy));
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-limitedDelta * 0.01));
}
function zoomBtn(inOut: number) {
    const c = pvCanvas.value;
    zoomAt(c ? c.clientWidth / 2 : 0, c ? c.clientHeight / 2 : 0, inOut > 0 ? 1.25 : 0.8);
}
function fitView() {
    const c = pvCanvas.value; if (!c) return;
    const svg = c.querySelector("svg") as SVGGraphicsElement | null;
    let sw = svg?.clientWidth || 0, sh = svg?.clientHeight || 0;
    if ((!sw || !sh) && svg?.getBBox) { try { const b = svg.getBBox(); sw = b.width; sh = b.height; } catch { /* */ } }
    if (!sw || !sh) { pvScale.value = 1; pvX.value = 0; pvY.value = 0; return; }
    const s = clampScale(Math.min(c.clientWidth / sw, c.clientHeight / sh) * 0.92);
    pvScale.value = s;
    pvX.value = (c.clientWidth - sw * s) / 2;
    pvY.value = (c.clientHeight - sh * s) / 2;
}

// ── 打回修正 ──
const rejectOpen = ref(false);
const rejectText = ref("");
const rejectInput = ref<HTMLInputElement | null>(null);
function openReject() {
    rejectText.value = "";
    rejectOpen.value = true;
    nextTick(() => rejectInput.value?.focus());
}
function onRejectEnter(event: KeyboardEvent) {
    if (isImeComposing(event)) return;
    event.preventDefault();
    confirmReject();
}
function confirmReject() {
    const v = rejectText.value.trim();
    if (!v) return;
    rejectOpen.value = false;
    submitPathReject(v); // → generateHandler 带 correction 重新分级
}

// ── 键盘：Space 预览，← → 聚焦 ──
function onKey(e: KeyboardEvent) {
    // Esc（捕获阶段优先）：有弹层先关弹层并阻止冒泡到 ChatPage 的撤回中断；无弹层才放行去中断
    if (e.key === "Escape") {
        if (previewOpen.value) { e.preventDefault(); e.stopImmediatePropagation(); closePreview(); return; }
        if (rejectOpen.value) { e.preventDefault(); e.stopImmediatePropagation(); rejectOpen.value = false; return; }
        return;
    }
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (previewOpen.value) closePreview();
        else openPreview(activeCard.value);
    } else if (e.key === "ArrowLeft") { e.preventDefault(); focusPrev(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); focusNext(); }
}

// ── 粒子流 ──
const fxRef = ref<HTMLCanvasElement | null>(null);
let particles: any[] = [], rafId = 0, last = 0;
const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function fxFrame(t: number) {
    rafId = requestAnimationFrame(fxFrame);
    const cv = fxRef.value as any; if (!cv) return;
    const ctx = cv._ctx || (cv._ctx = cv.getContext("2d"));
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth, h = window.innerHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dt = Math.min(34, (t - last) || 16); last = t;
    const k = dt / 16;
    const d = drag.value;
    if (d && !reduce && d.zone === "select" && stageRef.value) {
        const r = stageRef.value.getBoundingClientRect();
        const cx = r.left + r.width / 2 + d.baseX + d.dx;
        const cy = r.top + r.height / 2 + d.baseY + d.dy;
        let anchorY = Math.min(cy + d.halfH, h - 24);
        for (let i = 0; i < 7; i++) {
            const inward = Math.random();
            particles.push({
                x: cx + (Math.random() * 2 - 1) * d.halfW * 0.9,
                y: anchorY - inward * 150,
                vx: (Math.random() * 2 - 1) * 0.6,
                vy: 1.3 + Math.random() * 1.7,
                r0: (3 + inward * 11) * (0.85 + Math.random() * 0.3),
                life: 1, decay: 1 / (40 + Math.random() * 34),
                color: d.color,
            });
        }
        if (particles.length > 360) particles.splice(0, particles.length - 360);
    }
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) { p.x += p.vx * k; p.y += p.vy * k; p.life -= p.decay * k; }
    particles = particles.filter(p => p.life > 0);
    ctx.globalCompositeOperation = "lighter";
    for (const p of particles) {
        ctx.globalAlpha = p.life < 0 ? 0 : p.life;
        ctx.fillStyle = p.color;
        const rr = p.r0 * p.life;
        ctx.beginPath(); ctx.arc(p.x, p.y, rr > 0.4 ? rr : 0.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
}

onMounted(() => {
    buildCards();
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("keydown", onKey, true); // 捕获阶段，早于 ChatPage 的 Esc 中断
    rafId = requestAnimationFrame(fxFrame);
});
onUnmounted(() => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointermove", onDrag);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    window.removeEventListener("pointermove", pvMove);
    window.removeEventListener("pointerup", pvUp);
    cancelAnimationFrame(rafId);
});
</script>

<style scoped>
.path-cards {
    --pc-safe-top: 118px;
    --pc-stage-shift: 28px;
    position: fixed;
    inset: 0;
    z-index: 15;
    overflow: hidden;
    user-select: none;
    background: rgba(0, 0, 0, 0.82);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
    animation: pcFadeIn 0.3s ease-out;
    font-family: "Jiangxizhuokai", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
}
@keyframes pcFadeIn { from { opacity: 0; } to { opacity: 1; } }

.pc-head {
    position: fixed;
    top: var(--pc-safe-top);
    left: 0;
    right: 0;
    z-index: 600;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 0 24px;
    pointer-events: none;
    text-align: center;
}
.pc-level { font-size: 12px; letter-spacing: 0.08em; color: #c6b07d; opacity: 0.8; }
.pc-title { font-size: 20px; color: #d1c8b6; }
.pc-sub { font-size: 12px; color: rgba(209, 200, 182, 0.45); letter-spacing: 0.03em; }
.pc-sub kbd {
    padding: 1px 6px; border-radius: 5px; border: 1px solid rgba(255, 240, 225, 0.3);
    background: rgba(255, 255, 255, 0.08); font-size: 11px;
}

.pc-hints {
    position: fixed; left: 0; right: 0; bottom: 16vh; z-index: 600;
    display: flex; justify-content: center; pointer-events: none;
}
.pc-hint {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    font-size: 13px; letter-spacing: 0.12em; color: rgba(209, 200, 182, 0.4);
    transition: color 0.2s ease, transform 0.2s cubic-bezier(.34, 1.56, .64, 1);
}
.pc-hint .ar { font-size: 22px; line-height: 1; }
.pc-hint.on { color: #c6b07d; transform: scale(1.14); }

.pc-fx { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1500; }

.pc-stage {
    position: absolute; inset: 0; width: 100%; height: 100%;
    transform: translateY(var(--pc-stage-shift));
}
.pc-card {
    position: absolute; left: 50%; top: 50%; will-change: transform;
    transition: transform 0.55s cubic-bezier(.34, 1.56, .64, 1), opacity 0.35s ease;
}
.pc-card.grabbing { transition: none; }
.pc-card-inner {
    position: relative; width: 100%; height: 100%;
    border-radius: 10px; padding: 20px 16px 16px;
    display: flex; flex-direction: column; gap: 8px;
    cursor: grab; touch-action: none; will-change: transform;
    border: 1px solid rgba(209, 200, 182, 0.14);
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.38);
    background-image: linear-gradient(155deg, rgba(244, 241, 236, .08), rgba(0, 0, 0, .04));
    transition: transform 0.55s cubic-bezier(.34, 1.56, .64, 1), box-shadow 0.4s ease;
}
.pc-card-inner.active { box-shadow: 0 0 0 1px rgba(198, 176, 125, .5), 0 18px 46px rgba(0, 0, 0, .48); }
.pc-card-inner.grabbing { cursor: grabbing; box-shadow: 0 0 0 1px rgba(198, 176, 125, .7), 0 24px 60px rgba(0, 0, 0, .58); }
.pc-dots { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.pc-card-title { position: relative; z-index: 2; font-size: 17px; font-weight: 800; line-height: 1.3; }
.pc-card-summary {
    position: relative; z-index: 2; font-size: 12.5px; line-height: 1.5; font-weight: 400;
    opacity: 0.85; flex: 1; overflow: hidden;
}
.pc-card-hint { position: relative; z-index: 2; font-size: 11px; opacity: 0.55; }

/* mermaid 预览 */
.pc-preview {
    position: fixed; inset: 0; z-index: 2000;
    background: rgba(0, 0, 0, 0.78);
    display: flex; align-items: flex-start; justify-content: center;
    padding: var(--pc-safe-top) 4vw 24px;
    animation: pcFadeIn 0.18s ease-out;
}
.pc-preview-box {
    width: 92vw;
    height: calc(100vh - var(--pc-safe-top) - 24px);
    height: calc(100dvh - var(--pc-safe-top) - 24px);
    max-width: 1400px;
    background: rgba(4, 4, 2, 0.94); border: 1px solid rgba(209, 200, 182, 0.18);
    border-radius: 8px; display: flex; flex-direction: column; overflow: hidden;
}
.pc-preview-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 10px 14px 10px 18px; color: #d1c8b6; font-size: 15px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.pc-preview-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-preview-tools { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.pc-tool {
    min-width: 32px; height: 30px; padding: 0 8px;
    border: 1px solid rgba(209, 200, 182, 0.22); background: rgba(209, 200, 182, 0.05);
    color: #d1c8b6; border-radius: 4px; font-size: 14px; line-height: 1; cursor: pointer;
}
.pc-tool:hover { background: rgba(255, 255, 255, 0.16); }
.pc-tool.close { font-size: 20px; border-color: transparent; background: transparent; }

.pc-preview-canvas {
    flex: 1;
    overflow: hidden;
    position: relative;
    cursor: grab;
    touch-action: none;
    background:
        radial-gradient(circle at 1px 1px, rgba(255, 255, 255, 0.05) 1px, transparent 0) 0 0 / 22px 22px;
}
.pc-preview-canvas.grabbing { cursor: grabbing; }
.pc-preview-content {
    position: absolute;
    left: 0; top: 0;
    transform-origin: 0 0;
    will-change: transform;
}
.pc-preview-content :deep(svg) { max-width: none !important; height: auto; display: block; }
.pc-preview-content :deep(svg text) {
    font-family: "Jiangxizhuokai", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif !important;
}
/* 强制节点文字白色 + 黑描边，保证 AI 给节点上的任何高亮色背景上都可读 */
.pc-preview-content :deep(.nodeLabel),
.pc-preview-content :deep(.node foreignObject div),
.pc-preview-content :deep(.node text) {
    color: #fff !important;
    fill: #fff !important;
    text-shadow: 0 0 3px rgba(0, 0, 0, 0.95), 0 1px 2px rgba(0, 0, 0, 0.95);
}
.pc-preview-content :deep(.pc-preview-loading) { color: rgba(255, 245, 235, 0.5); padding: 20px; }
.pc-preview-content :deep(.pc-preview-err) {
    color: #ff9a8a; font-size: 12px; white-space: pre-wrap; font-family: monospace; padding: 20px;
}
.pc-preview-hint {
    padding: 7px 0; text-align: center;
    font-size: 11px; color: rgba(255, 245, 235, 0.4);
    border-top: 1px solid rgba(255, 255, 255, 0.06);
}

/* 打回 */
.pc-reject {
    position: fixed; left: 0; right: 0; bottom: 12vh; z-index: 700;
    display: flex; align-items: center; justify-content: center; gap: 10px;
    flex-wrap: wrap; padding: 0 24px;
}
.pc-reject-input {
    width: min(420px, 80vw);
    background: rgba(4, 4, 2, 0.86); border: 1px solid rgba(209, 200, 182, 0.28);
    border-radius: 4px; padding: 10px 14px; color: #f4f1ec; font-size: 14px; outline: none;
}
.pc-reject-input:focus { border-color: #c6b07d; }

.pc-foot {
    position: fixed; left: 0; right: 0; bottom: 24px; z-index: 700;
    display: flex; align-items: center; flex-wrap: wrap; justify-content: center;
    gap: 10px; padding: 0 28px; max-width: 680px; margin: 0 auto;
}
.pc-foot-spacer { flex: 1; }
.pc-nav {
    width: 38px; height: 38px; flex-shrink: 0;
    border: 1px solid rgba(209, 200, 182, 0.28); background: rgba(209, 200, 182, 0.05);
    color: #d1c8b6; border-radius: 4px; font-size: 20px; line-height: 1; cursor: pointer;
    transition: transform 0.15s ease, background 0.15s ease;
}
.pc-nav:hover:not(:disabled) { background: rgba(255, 255, 255, 0.18); transform: translateY(-1px); }
.pc-nav:disabled { opacity: 0.25; cursor: not-allowed; }
.pc-btn {
    border: 1px solid rgba(209, 200, 182, 0.28); background: rgba(209, 200, 182, 0.05);
    color: #d1c8b6; border-radius: 4px; padding: 8px 18px; font-size: 13px; cursor: pointer;
    transition: transform 0.15s ease, background 0.15s ease;
}
.pc-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.18); transform: translateY(-1px); }
.pc-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.pc-btn.ghost { background: transparent; opacity: 0.7; }
.pc-btn.ghost:hover:not(:disabled) { opacity: 1; background: rgba(255, 255, 255, 0.06); }
.pc-btn.primary { background: #d5c9ac; color: #040402; border-color: #e1d8c4; font-weight: 700; }
.pc-btn.primary:hover:not(:disabled) { background: #e1d8c4; }

@media (max-width: 820px) {
    .path-cards {
        --pc-safe-top: 92px;
        --pc-stage-shift: 20px;
    }
}

@media (max-height: 760px) {
    .path-cards {
        --pc-safe-top: 104px;
        --pc-stage-shift: 14px;
    }
}

@media (max-width: 820px) and (max-height: 760px) {
    .path-cards { --pc-safe-top: 84px; }
}

@media (prefers-reduced-motion: reduce) {
    .pc-card, .pc-card-inner, .pc-hint { transition: transform 0.15s linear, box-shadow 0.15s linear, opacity 0.15s linear; }
}
</style>

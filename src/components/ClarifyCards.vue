<template>
  <div class="clarify-cards">
    <!-- 顶部：进度 + 当前问题 -->
    <div class="cc-head">
      <div class="cc-progress">{{ qIndex + 1 }} / {{ todos.length }}</div>
      <div class="cc-question">{{ current?.question }}</div>
      <div class="cc-sub">
        {{ current?.multiSelect ? "多选 · 向下拖动加入组合" : "单选 · 向下拖动选择" }} · ← → 切换题目
      </div>
    </div>

    <!-- 拖动方向提示（开始拖动后出现） -->
    <div class="cc-hints" v-show="drag">
      <div class="cc-hint" :class="{ on: drag && drag.zone === 'select' }">
        <span class="ar">↓</span>{{ current?.multiSelect ? "加入组合" : "选择该牌" }}
      </div>
    </div>

    <canvas class="cc-fx" ref="fxRef"></canvas>

    <!-- 卡牌台 -->
    <div class="cc-stage" ref="stageRef">
      <div
        v-for="c in cards"
        v-show="!c.gone"
        :key="c.id"
        class="cc-card"
        :class="{ grabbing: drag && drag.id === c.id }"
        :style="outerStyle(c)"
      >
        <div
          class="cc-card-inner"
          :class="{ active: activeId === c.id, grabbing: drag && drag.id === c.id, selected: c.selected, custom: c.isCustom }"
          :style="innerStyle(c)"
          @pointerdown="startDrag($event, c)"
        >
          <svg class="cc-dots" :viewBox="`0 0 ${baseW} ${baseH}`" preserveAspectRatio="xMidYMid meet">
            <rect :x="6" :y="6" :width="baseW - 12" :height="baseH - 12" rx="14" ry="14"
                  fill="none" :stroke="dotColor(c)" stroke-width="3" stroke-linecap="round" stroke-dasharray="0.01 11"/>
          </svg>
          <div class="cc-card-label">{{ c.label }}</div>
          <div v-if="c.selected" class="cc-card-badge">已选</div>
        </div>
      </div>
    </div>

    <!-- 自定义输入（其他…） -->
    <div v-if="customOpen" class="cc-custom">
      <input ref="customInput" v-model="customText" class="cc-custom-input"
             placeholder="输入你的想法，回车确认" @keydown.enter.prevent="confirmCustom"/>
    </div>

    <!-- 底部控制 -->
    <div class="cc-foot">
      <button class="cc-nav" @click="goPrev" :disabled="qIndex === 0" title="上一题 (←)">‹</button>
      <button class="cc-btn ghost" @click="skip">跳过</button>
      <span class="cc-foot-spacer"></span>
      <span class="cc-count">已答 {{ answeredCount }} / {{ todos.length }}</span>
      <button v-if="current?.multiSelect" class="cc-btn" :disabled="selectedCount === 0" @click="confirmMulti">
        本题确认（{{ selectedCount }}）
      </button>
      <button v-if="allAnswered" class="cc-btn primary" @click="finish">完成确认</button>
      <button class="cc-nav" @click="goNext" :disabled="qIndex >= todos.length - 1" title="下一题 (→)">›</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { genTask, submitClarifyAnswers } from "../logic/generateState";
import type { TodoItem } from "../logic/generateState";

type CardKind = {
    id: string;
    label: string;
    value: string;
    isCustom: boolean;
    size: "s" | "m" | "l";
    color: string;
    selected: boolean;
    exiting: null | "return" | "chosen";
    entering: boolean;
    gone: boolean;
    relX: number;
    relY: number;
};

const palette: Record<string, { bg: string; text: string; dot: string }> = {
    cream:  { bg: "#f6ece0", text: "#5a4632", dot: "rgba(150,100,60,.5)"  },
    wheat:  { bg: "#e9c88f", text: "#5a4226", dot: "rgba(120,78,38,.5)"   },
    orange: { bg: "#e0954a", text: "#fff7ec", dot: "rgba(255,250,240,.6)" },
    brown:  { bg: "#9a6230", text: "#f8ead8", dot: "rgba(255,245,230,.55)"},
    cocoa:  { bg: "#6f4322", text: "#f3e2cf", dot: "rgba(255,240,222,.5)" },
    gray:   { bg: "#b4a695", text: "#403728", dot: "rgba(255,250,242,.6)" },
};
const colorKeys = ["cream", "wheat", "orange", "brown", "cocoa", "gray"];
const sizeFactor: Record<string, number> = { s: 0.86, m: 1, l: 1.16 };

const baseW = 184, baseH = 256;

// ── 题目流转 ──
const todos = computed<TodoItem[]>(() => genTask.clarifyTodos);
const qIndex = ref(0);
const current = computed<TodoItem | null>(() => todos.value[qIndex.value] || null);
const roundAnswers = reactive<Record<string, string | string[]>>({});

const cards = ref<CardKind[]>([]);
const customOpen = ref(false);
const customText = ref("");
const customInput = ref<HTMLInputElement | null>(null);

const selectedCount = computed(() => cards.value.filter(c => c.selected).length);

function buildCards() {
    const t = current.value;
    customOpen.value = false;
    customText.value = "";
    if (!t) { cards.value = []; return; }
    const single = !t.multiSelect;
    const list: CardKind[] = t.options.map((opt, i) => ({
        id: `${t.id}:${i}`, label: opt, value: opt, isCustom: false,
        size: "m", // 同一题卡片为同类，统一大小
        // 单选题：同类型卡（统一暖色）；多选题：组合卡（多色循环）
        color: single ? "wheat" : colorKeys[i % colorKeys.length],
        selected: false, exiting: null, entering: true, gone: false, relX: 0, relY: 0,
    }));
    if (t.allowCustom) {
        list.push({
            id: `${t.id}:custom`, label: "其他…", value: "", isCustom: true,
            size: "m", color: single ? "cream" : "gray",
            selected: false, exiting: null, entering: true, gone: false, relX: 0, relY: 0,
        });
    }
    // 重访已答题目时恢复此前选择（高亮，便于复核/修改）
    const prior = roundAnswers[t.id];
    if (prior !== undefined) {
        const arr = Array.isArray(prior) ? prior : [prior];
        for (const c of list) if (c.value && arr.includes(c.value)) c.selected = true;
    }
    cards.value = list;
    // 入场动画
    requestAnimationFrame(() => requestAnimationFrame(() => {
        cards.value.forEach(c => { c.entering = false; });
    }));
}

watch(() => current.value?.id, () => buildCards(), { immediate: true });

// ── 扇形布局（移植 reference）──
const laidOut = computed(() => cards.value.filter(c => !c.gone && !c.exiting));
const n = computed(() => laidOut.value.length);
const globalScale = computed(() => Math.max(0.6, Math.min(1.0, 1.0 - (n.value - 4) * 0.05)));
const step = computed(() => baseW * globalScale.value * 0.48);

const slots = computed(() => {
    const cnt = n.value, mid = (cnt - 1) / 2;
    const spread = Math.min(6, 26 / Math.max(cnt, 1));
    const map: Record<string, { x: number; rot: number; arc: number; idx: number }> = {};
    laidOut.value.forEach((c, idx) => {
        const d = idx - mid;
        map[c.id] = { x: d * step.value, rot: d * spread, arc: d * d * 1.8, idx };
    });
    return map;
});

const activeId = ref<string | null>(null);
const stageRef = ref<HTMLElement | null>(null);
const drag = ref<any>(null);

function geom(card: CardKind) {
    const gs = globalScale.value, sf = sizeFactor[card.size] ?? 1, bs = gs * sf;
    if (drag.value && drag.value.id === card.id) {
        const d = drag.value;
        return { x: d.baseX + d.dx, y: d.baseY + d.dy, rot: 0, scale: bs * 1.18, opacity: 1, z: 1000 };
    }
    if (card.exiting === "return") return { x: card.relX, y: card.relY - 270, rot: -10, scale: bs * 0.8, opacity: 0, z: 980 };
    if (card.exiting === "chosen") return { x: 0, y: 250, rot: 0, scale: bs * 0.5, opacity: 0, z: 990 };
    const slot = slots.value[card.id];
    if (!slot) return null;
    if (card.entering) return { x: slot.x, y: slot.arc + 200, rot: 0, scale: bs * 0.6, opacity: 0, z: 60 };
    const active = activeId.value === card.id;
    let rot = slot.rot, y = slot.arc, scale = bs, z = slot.idx + 1;
    if (card.selected) { rot = 0; y = slot.arc - 40; scale = bs * 1.12; z = 80; }
    else if (active) { rot = 0; y = slot.arc - 48; scale = bs * 1.18; z = 100; }
    return { x: slot.x, y, rot, scale, opacity: 1, z };
}

function outerStyle(card: CardKind) {
    const g = geom(card); if (!g) return { display: "none" };
    return {
        width: baseW + "px", height: baseH + "px", zIndex: g.z, opacity: g.opacity,
        transform: `translate(-50%,-50%) translate(${g.x}px, ${g.y}px)`,
    };
}
function innerStyle(card: CardKind) {
    const g = geom(card); if (!g) return {};
    return {
        background: palette[card.color].bg, color: palette[card.color].text,
        transform: `rotate(${g.rot}deg) scale(${g.scale})`,
    };
}
const dotColor = (card: CardKind) => palette[card.color].dot;

// ── 悬停聚焦 ──
function onMove(e: MouseEvent) {
    if (drag.value) return;
    const el = stageRef.value; if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = e.clientX - (r.left + r.width / 2), cy = e.clientY - (r.top + r.height / 2);
    if (Math.abs(cy) > baseH * globalScale.value * 0.5 + 90) { activeId.value = null; return; }
    let bestId: string | null = null, bestDist = Infinity;
    for (const c of laidOut.value) {
        const dist = Math.abs(cx - slots.value[c.id].x);
        if (dist < bestDist) { bestDist = dist; bestId = c.id; }
    }
    activeId.value = bestDist <= step.value + baseW * globalScale.value * 0.5 ? bestId : null;
}

// 向下拖到底部区域 = 选择
function zoneFor(y: number): "select" | "none" {
    return y > window.innerHeight * 0.72 ? "select" : "none";
}

function startDrag(e: PointerEvent, card: CardKind) {
    if (e.button !== 0 || card.exiting) return;
    e.preventDefault();
    const g = geom(card); if (!g) return;
    const sf = sizeFactor[card.size] ?? 1, sc = globalScale.value * sf * 1.18;
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
    if (!card) return;
    if (zone !== "select") return; // 未进入选择区 → 回弹到扇形原位
    if (card.isCustom) { openCustom(); return; }
    if (current.value?.multiSelect) toggleMulti(card);
    else selectSingle(card);
}

// ── 题目导航（← →）──
const answeredCount = computed(() => todos.value.filter(t => roundAnswers[t.id] !== undefined).length);
const allAnswered = computed(() => todos.value.length > 0 && answeredCount.value === todos.value.length);
const isLast = computed(() => qIndex.value >= todos.value.length - 1);

function goPrev() { if (qIndex.value > 0) qIndex.value--; }
function goNext() { if (qIndex.value < todos.value.length - 1) qIndex.value++; }

// ── 作答 ──
function selectSingle(card: CardKind) {
    if (!current.value) return;
    roundAnswers[current.value.id] = card.value;
    card.exiting = "chosen";
    for (const c of cards.value) if (c.id !== card.id) c.exiting = "return"; // 其余回归
    const last = isLast.value;
    setTimeout(() => {
        if (last) buildCards();   // 末题：重建当前题显示已选高亮，等待「完成确认」
        else qIndex.value++;       // 否则自动进入下一题（watch → buildCards）
    }, 480);
}

function toggleMulti(card: CardKind) {
    card.selected = !card.selected;
}
function confirmMulti() {
    if (!current.value) return;
    const picked = cards.value.filter(c => c.selected).map(c => c.value).filter(Boolean);
    roundAnswers[current.value.id] = picked;
    if (!isLast.value) goNext();
}

function skip() {
    if (!current.value) return;
    roundAnswers[current.value.id] = current.value.multiSelect ? [] : "";
    if (!isLast.value) goNext();
}

// ── 自定义输入 ──
function openCustom() {
    customOpen.value = true;
    customText.value = "";
    nextTick(() => customInput.value?.focus());
}
function confirmCustom() {
    const v = customText.value.trim();
    if (!v || !current.value) return;
    customOpen.value = false;
    if (current.value.multiSelect) {
        // 多选：把自定义值并入答案，标记自定义牌为已选
        const customCard = cards.value.find(c => c.isCustom);
        if (customCard) { customCard.value = v; customCard.label = v; customCard.selected = true; }
    } else {
        roundAnswers[current.value.id] = v;
        const customCard = cards.value.find(c => c.isCustom);
        if (customCard) customCard.exiting = "chosen";
        for (const c of cards.value) if (!c.isCustom) c.exiting = "return";
        const last = isLast.value;
        setTimeout(() => {
            if (last) buildCards();
            else qIndex.value++;
        }, 480);
    }
}

// 全部题目作答完成后，由「完成确认」提交本轮快照
function finish() {
    if (!allAnswered.value) return;
    const snapshot: Record<string, string | string[]> = {};
    for (const t of todos.value) snapshot[t.id] = roundAnswers[t.id] ?? (t.multiSelect ? [] : "");
    for (const k of Object.keys(roundAnswers)) delete roundAnswers[k];
    qIndex.value = 0;
    submitClarifyAnswers(snapshot);
}

// ── 粒子流（移植 reference，向下选择时喷发）──
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
        const margin = 24;
        let anchorY = Math.min(cy + d.halfH, h - margin);
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

// ← / → 切换题目（可返回上一题修改）
function onKey(e: KeyboardEvent) {
    if (customOpen.value) return;
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
}

onMounted(() => {
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("keydown", onKey);
    rafId = requestAnimationFrame(fxFrame);
});
onUnmounted(() => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("pointermove", onDrag);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    cancelAnimationFrame(rafId);
});
</script>

<style scoped>
.clarify-cards {
    position: fixed;
    inset: 0;
    z-index: 15;
    overflow: hidden;
    user-select: none;
    background: rgba(8, 6, 4, 0.82);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
    animation: ccFadeIn 0.3s ease-out;
}
@keyframes ccFadeIn { from { opacity: 0; } to { opacity: 1; } }

.cc-head {
    position: fixed;
    top: 84px;
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
.cc-progress {
    font-size: 12px;
    letter-spacing: 0.08em;
    color: wheat;
    opacity: 0.7;
}
.cc-question {
    font-size: 20px;
    line-height: 1.4;
    color: #f3e7d4;
    max-width: 640px;
    text-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
}
.cc-sub {
    font-size: 12px;
    color: rgba(255, 245, 235, 0.45);
    letter-spacing: 0.04em;
}

.cc-hints {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 16vh;
    z-index: 600;
    display: flex;
    justify-content: center;
    pointer-events: none;
}
.cc-hint {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    font-size: 13px;
    letter-spacing: 0.12em;
    color: rgba(255, 245, 235, 0.4);
    transition: color 0.2s ease, transform 0.2s cubic-bezier(.34, 1.56, .64, 1);
}
.cc-hint .ar { font-size: 22px; line-height: 1; }
.cc-hint.on { color: #8fd16a; transform: scale(1.22); }

.cc-fx {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 1500;
}

.cc-stage {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
}

.cc-card {
    position: absolute;
    left: 50%;
    top: 50%;
    will-change: transform;
    transition: transform 0.55s cubic-bezier(.34, 1.56, .64, 1), opacity 0.35s ease;
}
.cc-card.grabbing { transition: none; }

.cc-card-inner {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 18px;
    padding: 18px 16px;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    cursor: grab;
    touch-action: none;
    will-change: transform;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    background-image: linear-gradient(155deg, rgba(255, 255, 255, .18), rgba(0, 0, 0, .06));
    transition: transform 0.55s cubic-bezier(.34, 1.56, .64, 1), box-shadow 0.4s ease;
}
.cc-card-inner.active { box-shadow: 0 10px 40px rgba(255, 180, 120, .2), 0 8px 24px rgba(0, 0, 0, .5); }
.cc-card-inner.grabbing { cursor: grabbing; box-shadow: 0 16px 60px rgba(255, 180, 120, .3), 0 12px 30px rgba(0, 0, 0, .55); }
.cc-card-inner.selected { box-shadow: 0 12px 44px rgba(143, 209, 106, .35), 0 8px 24px rgba(0, 0, 0, .5); }
.cc-card-inner.custom { background-image: linear-gradient(155deg, rgba(255, 255, 255, .1), rgba(0, 0, 0, .12)); }

.cc-dots { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.cc-card-label {
    position: relative;
    z-index: 2;
    font-size: 17px;
    font-weight: 700;
    line-height: 1.3;
    word-break: break-word;
}
.cc-card-badge {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 2;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 8px;
    background: rgba(60, 120, 40, 0.85);
    color: #eaffd8;
    letter-spacing: 0.04em;
}

.cc-custom {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 12vh;
    z-index: 700;
    display: flex;
    justify-content: center;
    padding: 0 24px;
}
.cc-custom-input {
    width: min(420px, 90vw);
    background: rgba(20, 16, 12, 0.9);
    border: 1px solid rgba(255, 240, 225, 0.28);
    border-radius: 10px;
    padding: 10px 14px;
    color: #f3e7d4;
    font-size: 14px;
    outline: none;
}
.cc-custom-input:focus { border-color: wheat; }

.cc-foot {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 24px;
    z-index: 700;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px;
    padding: 0 28px;
    max-width: 680px;
    margin: 0 auto;
}
.cc-foot-spacer { flex: 1; }
.cc-btn {
    border: 1px solid rgba(255, 240, 225, 0.28);
    background: rgba(255, 255, 255, 0.08);
    color: #f3e7d4;
    border-radius: 11px;
    padding: 9px 20px;
    font-size: 14px;
    cursor: pointer;
    transition: transform 0.15s ease, background 0.15s ease;
}
.cc-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.18); transform: translateY(-1px); }
.cc-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.cc-btn.ghost { background: transparent; opacity: 0.6; }
.cc-btn.ghost:hover { opacity: 1; background: rgba(255, 255, 255, 0.06); }
.cc-btn.primary {
    background: wheat;
    color: #1c1812;
    border-color: wheat;
    font-weight: 700;
}
.cc-btn.primary:hover:not(:disabled) { background: #f0d9a8; }

.cc-nav {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border: 1px solid rgba(255, 240, 225, 0.28);
    background: rgba(255, 255, 255, 0.08);
    color: #f3e7d4;
    border-radius: 10px;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    transition: transform 0.15s ease, background 0.15s ease;
}
.cc-nav:hover:not(:disabled) { background: rgba(255, 255, 255, 0.18); transform: translateY(-1px); }
.cc-nav:disabled { opacity: 0.25; cursor: not-allowed; }

.cc-count {
    font-size: 12px;
    color: rgba(255, 245, 235, 0.5);
    letter-spacing: 0.04em;
}

@media (prefers-reduced-motion: reduce) {
    .cc-card, .cc-card-inner, .cc-hint {
        transition: transform 0.15s linear, box-shadow 0.15s linear, opacity 0.15s linear;
    }
}
</style>

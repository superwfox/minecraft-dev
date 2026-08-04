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
                  fill="none" :stroke="dotColor(c)" stroke-width="3" stroke-linecap="round" pathLength="792" stroke-dasharray="0.01 10.99"/>
          </svg>
          <div class="cc-card-label">{{ c.label }}</div>
          <div v-if="c.selected" class="cc-card-badge">已选</div>
        </div>
      </div>
    </div>

    <!-- 自定义输入（其他…）：实时映射到卡面 -->
    <div v-if="customOpen" class="cc-custom">
      <input ref="customInput" v-model="customText" class="cc-custom-input"
             placeholder="输入你的想法…"
             @input="onCustomInput"
             @compositionstart="onImeCompositionStart"
             @compositionend="onImeCompositionEnd"
             @keydown.enter="onCustomEnter"
             @keydown.esc.stop.prevent="cancelCustom"/>
      <button class="cc-btn primary" :disabled="!customText.trim()" @click="confirmCustom">确定</button>
      <button class="cc-btn ghost" @click="cancelCustom">取消</button>
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
import {isImeComposing, onImeCompositionEnd, onImeCompositionStart} from "../logic/keyboard";

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
    cream:  { bg: "#d1c8b6", text: "#040402", dot: "rgba(4,4,2,.28)"       },
    wheat:  { bg: "#c6b07d", text: "#040402", dot: "rgba(4,4,2,.34)"       },
    orange: { bg: "#423725", text: "#f4f1ec", dot: "rgba(213,201,172,.4)"  },
    brown:  { bg: "#262626", text: "#d1c8b6", dot: "rgba(209,200,182,.3)"  },
    cocoa:  { bg: "#090907", text: "#d1c8b6", dot: "rgba(209,200,182,.34)" },
    gray:   { bg: "#4a4a4a", text: "#f4f1ec", dot: "rgba(244,241,236,.32)" },
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
let editingCustom: CardKind | null = null; // 正在编辑的「其他…」牌

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
    // 重访已答题目时恢复此前选择（高亮，便于复核/修改）；自定义答案回填到「其他…」牌
    const prior = roundAnswers[t.id];
    if (prior !== undefined) {
        const arr = Array.isArray(prior) ? prior : (prior === "" ? [] : [prior]);
        const optSet = new Set(t.options);
        for (const c of list) {
            if (c.isCustom) {
                const customVal = arr.find(a => a && !optSet.has(a));
                if (customVal) { c.value = customVal; c.label = customVal; c.selected = true; }
            } else if (c.value && arr.includes(c.value)) {
                c.selected = true;
            }
        }
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
    if (card.isCustom) { openCustom(card); return; }
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
    if (customOpen.value) cancelCustom();
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
    if (customOpen.value) cancelCustom();
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

// ── 自定义输入（其他…）──
function openCustom(card: CardKind) {
    editingCustom = card;
    customOpen.value = true;
    customText.value = card.value || ""; // 重新编辑时回填
    card.selected = true;                // 编辑中即点亮该牌
    onCustomInput();                     // 同步当前文字到卡面
    nextTick(() => customInput.value?.focus());
}
// 输入实时映射到卡面
function onCustomInput() {
    if (editingCustom) editingCustom.label = customText.value.trim() || "其他…";
}
function onCustomEnter(event: KeyboardEvent) {
    if (isImeComposing(event)) return;
    event.preventDefault();
    confirmCustom();
}
function confirmCustom() {
    const v = customText.value.trim();
    const card = editingCustom;
    if (!card || !current.value) { customOpen.value = false; return; }
    if (!v) { cancelCustom(); return; }
    card.value = v;
    card.label = v;
    customOpen.value = false;
    editingCustom = null;
    if (current.value.multiSelect) {
        card.selected = true; // 已选，纳入组合（点「本题确认」提交）
    } else {
        roundAnswers[current.value.id] = v;
        card.exiting = "chosen";
        for (const c of cards.value) if (c.id !== card.id) c.exiting = "return";
        const last = isLast.value;
        setTimeout(() => {
            if (last) buildCards();
            else qIndex.value++;
        }, 480);
    }
}
function cancelCustom() {
    customOpen.value = false;
    customText.value = "";
    if (editingCustom) {
        editingCustom.label = "其他…";
        editingCustom.value = "";
        editingCustom.selected = false;
        editingCustom = null;
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
    --cc-head-top: 118px;
    --cc-stage-shift: 28px;
    position: fixed;
    inset: 0;
    z-index: 15;
    overflow: hidden;
    user-select: none;
    background: rgba(0, 0, 0, 0.82);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
    animation: ccFadeIn 0.3s ease-out;
    font-family: "Jiangxizhuokai", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
}
@keyframes ccFadeIn { from { opacity: 0; } to { opacity: 1; } }

.cc-head {
    position: fixed;
    top: var(--cc-head-top);
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
    color: #c6b07d;
    opacity: 0.7;
}
.cc-question {
    font-size: 20px;
    line-height: 1.4;
    color: #d1c8b6;
    max-width: 640px;
    text-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
}
.cc-sub {
    font-size: 12px;
    color: rgba(209, 200, 182, 0.45);
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
    color: rgba(209, 200, 182, 0.4);
    transition: color 0.2s ease, transform 0.2s cubic-bezier(.34, 1.56, .64, 1);
}
.cc-hint .ar { font-size: 22px; line-height: 1; }
.cc-hint.on { color: #c6b07d; transform: scale(1.14); }

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
    transform: translateY(var(--cc-stage-shift));
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
    border-radius: 10px;
    padding: 18px 16px;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    cursor: grab;
    touch-action: none;
    will-change: transform;
    border: 1px solid rgba(209, 200, 182, 0.14);
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.38);
    background-image: linear-gradient(155deg, rgba(244, 241, 236, .08), rgba(0, 0, 0, .04));
    transition: transform 0.55s cubic-bezier(.34, 1.56, .64, 1), box-shadow 0.4s ease;
}
.cc-card-inner.active { box-shadow: 0 0 0 1px rgba(198, 176, 125, .5), 0 18px 46px rgba(0, 0, 0, .48); }
.cc-card-inner.grabbing { cursor: grabbing; box-shadow: 0 0 0 1px rgba(198, 176, 125, .7), 0 24px 60px rgba(0, 0, 0, .58); }
.cc-card-inner.selected { box-shadow: 0 0 0 2px rgba(213, 201, 172, .72), 0 18px 48px rgba(0, 0, 0, .52); }
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
    border-radius: 4px;
    background: #d5c9ac;
    color: #040402;
    letter-spacing: 0.04em;
}

.cc-custom {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 12vh;
    z-index: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 0 24px;
}
.cc-custom-input {
    width: min(360px, 80vw);
    background: rgba(4, 4, 2, 0.86);
    border: 1px solid rgba(209, 200, 182, 0.28);
    border-radius: 4px;
    padding: 10px 14px;
    color: #f4f1ec;
    font-size: 14px;
    outline: none;
}
.cc-custom-input:focus { border-color: #c6b07d; }

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
    border: 1px solid rgba(209, 200, 182, 0.28);
    background: rgba(209, 200, 182, 0.05);
    color: #d1c8b6;
    border-radius: 4px;
    padding: 8px 18px;
    font-size: 13px;
    cursor: pointer;
    transition: transform 0.15s ease, background 0.15s ease;
}
.cc-btn:hover:not(:disabled) { background: rgba(209, 200, 182, 0.1); transform: translateY(-1px); }
.cc-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.cc-btn.ghost { background: transparent; opacity: 0.6; }
.cc-btn.ghost:hover { opacity: 1; background: rgba(255, 255, 255, 0.06); }
.cc-btn.primary {
    background: #d5c9ac;
    color: #040402;
    border-color: #e1d8c4;
    font-weight: 700;
}
.cc-btn.primary:hover:not(:disabled) { background: #e1d8c4; }

.cc-nav {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border: 1px solid rgba(209, 200, 182, 0.28);
    background: rgba(209, 200, 182, 0.05);
    color: #d1c8b6;
    border-radius: 4px;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    transition: transform 0.15s ease, background 0.15s ease;
}
.cc-nav:hover:not(:disabled) { background: rgba(255, 255, 255, 0.18); transform: translateY(-1px); }
.cc-nav:disabled { opacity: 0.25; cursor: not-allowed; }

.cc-count {
    font-size: 12px;
    color: rgba(209, 200, 182, 0.5);
    letter-spacing: 0.04em;
}

@media (max-width: 820px) {
    .clarify-cards {
        --cc-head-top: 92px;
        --cc-stage-shift: 20px;
    }
}

@media (max-height: 760px) {
    .clarify-cards {
        --cc-head-top: 104px;
        --cc-stage-shift: 14px;
    }
}

@media (max-width: 820px) and (max-height: 760px) {
    .clarify-cards { --cc-head-top: 84px; }
}

@media (prefers-reduced-motion: reduce) {
    .cc-card, .cc-card-inner, .cc-hint {
        transition: transform 0.15s linear, box-shadow 0.15s linear, opacity 0.15s linear;
    }
}
</style>

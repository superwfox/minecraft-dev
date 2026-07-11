<template>
  <div class="skills-page">
    <!-- 顶部标题 -->
    <div class="sk-head">
      <div class="sk-title">技能库 · Skill Library</div>
      <div class="sk-sub">
        <template v-if="skillsState.loading">正在从社区仓库加载…</template>
        <template v-else-if="skillsState.error">加载失败：{{ skillsState.error }}（可稍后刷新）</template>
        <template v-else>像安排手牌一样挑选能力 · 已收录 {{ skillsState.all.length }} 个</template>
      </div>
      <div class="sk-contrib"><SkillSubmit/></div>
    </div>

    <!-- 拖动方向提示 -->
    <div class="sk-edge-hints" v-show="drag">
      <div class="sk-edge-hint" :class="{ on: drag && drag.zone === 'collapse' }">
        <span class="ar">↓</span>加入手牌
      </div>
    </div>

    <canvas class="sk-fx" ref="fxRef"></canvas>

    <!-- 卡牌台（扇形手牌） -->
    <div class="sk-stage" ref="stageRef">
      <div
        v-for="c in cards"
        v-show="cardShown(c)"
        :key="c.id"
        class="sk-card"
        :class="{ grabbing: drag && drag.id === c.id }"
        :style="outerStyle(c)"
      >
        <div
          class="sk-card-inner"
          :class="{ active: activeId === c.id, readme: c.kind === 'readme', grabbing: drag && drag.id === c.id }"
          :style="innerStyle(c)"
          @pointerdown="startDrag($event, c)"
        >
          <svg class="sk-dots" :viewBox="`0 0 ${baseW} ${baseH}`" preserveAspectRatio="xMidYMid meet">
            <rect :x="6" :y="6" :width="baseW - 12" :height="baseH - 12" rx="14" ry="14"
                  fill="none" :stroke="dotColor(c)" stroke-width="3" stroke-linecap="round" pathLength="792" stroke-dasharray="0.01 10.99"/>
          </svg>

          <div class="sk-card-top">{{ c.kind === 'readme' ? '技能库' : (c.brief!.author || 'skill') }}</div>
          <div class="sk-card-body">
            <div class="sk-card-label">{{ c.label }}</div>
            <div class="sk-card-desc">{{ c.sub }}</div>
            <div v-if="c.tags.length" class="sk-card-tags">
              <span v-for="t in c.tags" :key="t" class="sk-tag">{{ t }}</span>
            </div>
            <button v-if="c.kind === 'skill'" type="button" class="sk-card-action"
                    @pointerdown.stop @click.stop="selectCard(c)">add skill</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 已选手牌（底部收集区，点击移出） -->
    <div class="sk-tray" v-show="chosen.length">
      <span class="sk-tray-label">我的手牌 · 点击移出</span>
      <button v-for="b in chosen" :key="b.id" class="sk-chip" :style="chipStyle(b)" @click="unselect(b)">
        {{ b.name || b.id }}
      </button>
    </div>

    <div class="sk-hint" :class="{ raised: chosen.length }">点击 add skill 或向下拖动加入 · 点击卡片 / Space 查看详情</div>

    <!-- README 弹层 -->
    <Teleport to="body">
      <div v-if="readmeOpen" class="sk-overlay" @click.self="readmeOpen = false">
        <div class="sk-modal sk-readme glass2">
          <div class="sk-modal-head">
            <span class="sk-modal-title">技能库说明</span>
            <button class="sk-x" @click="readmeOpen = false">✕</button>
          </div>
          <div class="sk-md" v-html="readmeHtml"></div>
        </div>
      </div>
    </Teleport>

    <!-- skill 详情弹层 -->
    <Teleport to="body">
      <div v-if="detail" class="sk-overlay" @click.self="detail = null">
        <div class="sk-modal sk-detail glass2">
          <div class="sk-modal-head">
            <span class="sk-modal-title">{{ detail.name }}</span>
            <button class="sk-x" @click="detail = null">✕</button>
          </div>
          <div class="sk-detail-meta">
            <span v-if="detail.author">作者 {{ detail.author }}</span>
            <span v-if="detail.version">v{{ detail.version }}</span>
            <span v-if="detail.coreTypes && detail.coreTypes.length">{{ detail.coreTypes.join(' / ') }}</span>
          </div>
          <p v-if="detail.capability" class="sk-detail-cap">{{ detail.capability }}</p>
          <p v-if="detail.description" class="sk-detail-desc">{{ detail.description }}</p>
          <div v-if="detail.tags && detail.tags.length" class="sk-card-tags">
            <span v-for="t in detail.tags" :key="t" class="sk-tag">{{ t }}</span>
          </div>

          <div v-if="detail.structure && detail.structure.length" class="sk-struct">
            <div class="sk-struct-title">文件结构</div>
            <div v-for="(s, i) in detail.structure" :key="i" class="sk-struct-row">
              <span class="sk-struct-kind" :class="s.kind">{{ s.kind }}</span>
              <span class="sk-struct-file">{{ s.file }}</span>
              <span v-if="s.fileGen" class="sk-struct-gen">{{ s.fileGen }}</span>
              <span v-if="s.role" class="sk-struct-role">{{ s.role }}</span>
            </div>
          </div>

          <div class="sk-detail-actions">
            <button class="sk-btn" :class="isSelected(detail.id) ? 'ghost' : 'primary'" @click="toggleSkill(detail.id)">
              {{ isSelected(detail.id) ? '移出手牌' : '加入手牌' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { skillsState, fetchSkills, isSelected, toggleSkill, addSkill, removeSkill, selectedBriefs } from "../logic/skills";
import type { SkillBrief } from "../logic/skills";
import { renderMarkdown } from "../logic/miniMarkdown";
import SkillSubmit from "../components/SkillSubmit.vue";

type SkCard = {
    id: string;
    kind: "readme" | "skill";
    label: string;
    sub: string;
    tags: string[];
    color: string;
    brief?: SkillBrief;
    exiting: null | "down";
    entering: boolean;
    relX: number;
    relY: number;
};

const palette: Record<string, { bg: string; text: string; dot: string }> = {
    cocoa:  { bg: "#090907", text: "#d1c8b6", dot: "rgba(209,200,182,.34)" },
    wheat:  { bg: "#c6b07d", text: "#040402", dot: "rgba(4,4,2,.34)"       },
    orange: { bg: "#423725", text: "#f4f1ec", dot: "rgba(213,201,172,.4)"  },
    brown:  { bg: "#262626", text: "#d1c8b6", dot: "rgba(209,200,182,.3)"  },
    cream:  { bg: "#d1c8b6", text: "#040402", dot: "rgba(4,4,2,.28)"       },
    gray:   { bg: "#4a4a4a", text: "#f4f1ec", dot: "rgba(244,241,236,.32)" },
};
const skillColors = ["wheat", "orange", "brown", "cream", "gray"];
const baseW = 184, baseH = 256;

// ── 卡片（本地态，持退场/入场瞬态）──
const cards = ref<SkCard[]>([]);
function buildCards() {
    const list: SkCard[] = [{
        id: "__readme__", kind: "readme", color: "cocoa",
        label: "README", sub: "技能库说明 · 点击查看", tags: [],
        exiting: null, entering: false, relX: 0, relY: 0,
    }];
    skillsState.all.forEach((b, i) => {
        list.push({
            id: b.id, kind: "skill", brief: b, color: skillColors[i % skillColors.length],
            label: b.name || b.id, sub: b.capability || b.description || "",
            tags: (b.tags || []).slice(0, 3),
            exiting: null, entering: false, relX: 0, relY: 0,
        });
    });
    cards.value = list;
}
watch(() => skillsState.all, buildCards, { immediate: true });

const colorOf = (id: string) => cards.value.find((c) => c.id === id)?.color ?? "wheat";

// 卡是否在手牌区显示：README 始终；skill 仅未选（退场动画期间仍显示）
function cardShown(c: SkCard): boolean {
    return !!c.exiting || c.kind === "readme" || !isSelected(c.brief!.id);
}
// 参与扇形布局的卡（退场中的不占位 → 手牌立即收拢）
const laidOut = computed(() => cards.value.filter((c) => !c.exiting && (c.kind === "readme" || !isSelected(c.brief!.id))));
const chosen = computed(() => selectedBriefs());

// ── 扇形布局 ──
const n = computed(() => laidOut.value.length);
const globalScale = computed(() => Math.max(0.58, Math.min(1.0, 1.0 - (n.value - 5) * 0.045)));
const step = computed(() => baseW * globalScale.value * 0.5);
const slots = computed(() => {
    const cnt = n.value, mid = (cnt - 1) / 2;
    const spread = Math.min(5.5, 24 / Math.max(cnt, 1));
    const map: Record<string, { x: number; rot: number; arc: number; idx: number }> = {};
    laidOut.value.forEach((c, idx) => {
        const d = idx - mid;
        map[c.id] = { x: d * step.value, rot: d * spread, arc: d * d * 1.6, idx };
    });
    return map;
});

const activeId = ref<string | null>(null);
const stageRef = ref<HTMLElement | null>(null);
const drag = ref<any>(null);

function geom(card: SkCard) {
    const bs = globalScale.value;
    if (drag.value && drag.value.id === card.id) {
        const d = drag.value;
        return { x: d.baseX + d.dx, y: d.baseY + d.dy, rot: 0, scale: bs * 1.18, opacity: 1, z: 1000 };
    }
    if (card.exiting === "down") return { x: card.relX, y: card.relY + 220, rot: 4, scale: bs * 0.62, opacity: 0.15, z: 999 };
    const slot = slots.value[card.id];
    if (!slot) return null;
    if (card.entering) return { x: slot.x, y: slot.arc + 170, rot: 0, scale: bs * 0.6, opacity: 0, z: 60 };
    const active = activeId.value === card.id;
    let rot = slot.rot, y = slot.arc, scale = bs, z = slot.idx + 1;
    if (active) { rot = 0; y = slot.arc - 46; scale = bs * 1.16; z = 200; }
    return { x: slot.x, y, rot, scale, opacity: 1, z };
}
function outerStyle(card: SkCard) {
    const g = geom(card); if (!g) return { display: "none" };
    return {
        width: baseW + "px", height: baseH + "px", zIndex: g.z, opacity: g.opacity,
        transform: `translate(-50%,-50%) translate(${g.x}px, ${g.y}px)`,
    };
}
function innerStyle(card: SkCard) {
    const g = geom(card); if (!g) return {};
    return {
        background: palette[card.color].bg, color: palette[card.color].text,
        transform: `rotate(${g.rot}deg) scale(${g.scale})`,
    };
}
const dotColor = (card: SkCard) => palette[card.color].dot;
const chipStyle = (b: SkillBrief) => {
    const c = palette[colorOf(b.id)] ?? palette.wheat;
    return { background: c.bg, color: c.text };
};

// 悬停聚焦
function onMove(e: MouseEvent) {
    if (drag.value) return;
    const el = stageRef.value; if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = e.clientX - (r.left + r.width / 2), cy = e.clientY - (r.top + r.height / 2);
    if (Math.abs(cy) > baseH * globalScale.value * 0.6 + 80) { activeId.value = null; return; }
    let best: string | null = null, bestDist = Infinity;
    for (const c of laidOut.value) {
        const dist = Math.abs(cx - slots.value[c.id].x);
        if (dist < bestDist) { bestDist = dist; best = c.id; }
    }
    activeId.value = bestDist <= step.value + baseW * globalScale.value * 0.5 ? best : null;
}

// ── 拖拽：向下拖入手牌（collapse）；小位移=点击预览 ──
function zoneFor(y: number): "collapse" | "none" {
    return y > window.innerHeight * 0.8 ? "collapse" : "none";
}
function startDrag(e: PointerEvent, card: SkCard) {
    if (e.button !== 0 || card.exiting) return;
    e.preventDefault();
    const g = geom(card); if (!g) return;
    const sc = globalScale.value * 1.18;
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
    const card = cards.value.find((c) => c.id === d.id);
    const zone = d.zone;
    const moved = Math.hypot(d.dx, d.dy);
    if (card) { card.relX = d.baseX + d.dx; card.relY = d.baseY + d.dy; }
    drag.value = null;
    if (!card) return;
    // 几乎没动 = 点击 → 预览
    if (moved < 8) { openCard(card); return; }
    // 向下拖入手牌（README 不可选 → 回弹）
    if (zone === "collapse") selectCard(card);
}

function selectCard(card: SkCard) {
    if (card.kind !== "skill" || card.exiting || isSelected(card.brief!.id)) return;
    card.exiting = "down";
    setTimeout(() => {
        card.exiting = null;
        addSkill(card.brief!.id);
    }, 360);
}

// 从手牌移出（点 chip）→ 回扇形，入场动画
function unselect(b: SkillBrief) {
    removeSkill(b.id);
    const c = cards.value.find((x) => x.id === b.id);
    if (c) {
        c.entering = true;
        requestAnimationFrame(() => requestAnimationFrame(() => { c.entering = false; }));
    }
}

// ── 弹层 ──
const readmeOpen = ref(false);
const detail = ref<SkillBrief | null>(null);
const readmeHtml = computed(() => renderMarkdown(skillsState.readme) || "<p>（暂无说明）</p>");
function openCard(c: SkCard) {
    if (c.kind === "readme") readmeOpen.value = true;
    else detail.value = c.brief || null;
}
function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { readmeOpen.value = false; detail.value = null; return; }
    if (e.key === " " || e.code === "Space") {
        if (readmeOpen.value || detail.value) { e.preventDefault(); readmeOpen.value = false; detail.value = null; return; }
        const c = cards.value.find((x) => x.id === activeId.value);
        if (c) { e.preventDefault(); openCard(c); }
    }
}

// ── 粒子流（向下喷发，移植 reference）──
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
    if (d && !reduce && d.zone === "collapse" && stageRef.value) {
        const r = stageRef.value.getBoundingClientRect();
        const cx = r.left + r.width / 2 + d.baseX + d.dx;
        const cy = r.top + r.height / 2 + d.baseY + d.dy;
        const anchorY = Math.min(cy + d.halfH, h - 24);
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
    particles = particles.filter((p) => p.life > 0);
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
    fetchSkills();
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
.skills-page {
    position: fixed;
    inset: 0;
    overflow: hidden;
    user-select: none;
}

.sk-head {
    position: fixed;
    top: 92px;
    left: 0;
    right: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    pointer-events: none;
    text-align: center;
    padding: 0 24px;
}
.sk-title { font-family: "MinecrafterAlt", "ZhuoKai", sans-serif; font-size: 22px; color: #d1c8b6; }
.sk-sub { font-size: 12px; color: rgba(209, 200, 182, 0.48); letter-spacing: 0.03em; }
.sk-contrib { margin-top: 10px; pointer-events: auto; }

.sk-edge-hints {
    position: fixed;
    left: 0; right: 0;
    bottom: 17vh;
    z-index: 600;
    display: flex;
    justify-content: center;
    pointer-events: none;
}
.sk-edge-hint {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    font-size: 12px; letter-spacing: 0.1em; color: rgba(209, 200, 182, 0.4);
    transition: color 0.2s ease, transform 0.2s cubic-bezier(.34, 1.56, .64, 1);
}
.sk-edge-hint .ar { font-size: 22px; line-height: 1; }
.sk-edge-hint.on { color: #c6b07d; transform: scale(1.14); }

.sk-fx { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1500; }

.sk-stage { position: absolute; left: 0; right: 0; top: 52%; height: 0; }

.sk-card {
    position: absolute;
    left: 50%;
    top: 0;
    will-change: transform;
    transition: transform 0.5s cubic-bezier(.34, 1.56, .64, 1), opacity 0.35s ease;
}
.sk-card.grabbing { transition: none; }
.sk-card-inner {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 10px;
    padding: 16px 15px;
    display: flex;
    flex-direction: column;
    cursor: grab;
    touch-action: none;
    border: 1px solid rgba(209, 200, 182, 0.14);
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.34);
    background-image: linear-gradient(155deg, rgba(244, 241, 236, .08), rgba(0, 0, 0, .04));
    transition: transform 0.5s cubic-bezier(.34, 1.56, .64, 1), box-shadow 0.35s ease;
}
.sk-card-inner.active { box-shadow: 0 0 0 1px rgba(198, 176, 125, .52), 0 18px 46px rgba(0, 0, 0, .46); }
.sk-card-inner.grabbing { cursor: grabbing; box-shadow: 0 0 0 1px rgba(198, 176, 125, .72), 0 24px 60px rgba(0, 0, 0, .58); }
.sk-card-inner.readme { background-image: linear-gradient(155deg, rgba(255, 255, 255, .1), rgba(0, 0, 0, .14)); }

.sk-dots { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.sk-card-top { position: relative; z-index: 2; font-size: 11px; opacity: 0.7; letter-spacing: 0.05em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sk-card-body { position: relative; z-index: 2; margin-top: auto; display: flex; flex-direction: column; gap: 7px; }
.sk-card-label { font-size: 18px; font-weight: 700; line-height: 1.25; word-break: break-word; }
.sk-card-desc { font-size: 12px; line-height: 1.4; opacity: 0.78; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.sk-card-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.sk-tag { font-size: 10px; padding: 1px 7px; border-radius: 7px; background: rgba(0, 0, 0, 0.18); opacity: 0.85; }
.sk-card-action {
    align-self: flex-start;
    margin-top: 3px;
    height: 26px;
    padding: 0 9px;
    border: 1px solid currentColor;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.08);
    color: inherit;
    font-family: "MinecrafterAlt", sans-serif;
    font-size: 9px;
    cursor: pointer;
    opacity: 0.72;
    transition: opacity 0.16s ease, background 0.16s ease;
}
.sk-card-action:hover { opacity: 1; background: rgba(255, 255, 255, 0.1); }
.sk-card-action:focus-visible { outline: 2px solid #f4f1ec; outline-offset: 2px; }

/* 已选手牌收集区 */
.sk-tray {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    min-height: 13vh;
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 10px;
    padding: 22px 24px 18px;
    background: linear-gradient(0deg, rgba(198, 176, 125, 0.055), transparent);
}
.sk-tray-label { position: absolute; top: 4px; left: 0; right: 0; text-align: center; font-size: 12px; letter-spacing: 0.06em; opacity: 0.45; pointer-events: none; }
.sk-chip {
    border: none;
    border: 1px solid rgba(209, 200, 182, 0.18);
    border-radius: 4px;
    padding: 9px 16px;
    cursor: pointer;
    font-weight: 700;
    font-size: 14px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
    transition: transform 0.18s cubic-bezier(.34, 1.56, .64, 1), box-shadow 0.18s ease;
    animation: skChipIn 0.42s cubic-bezier(.34, 1.56, .64, 1);
}
.sk-chip:hover { transform: translateY(-4px); box-shadow: 0 10px 22px rgba(0, 0, 0, 0.6); }
.sk-chip:active { transform: translateY(-1px) scale(0.96); }
@keyframes skChipIn {
    0% { transform: scale(0.5) translateY(28px); opacity: 0; }
    60% { transform: scale(1.08) translateY(-3px); opacity: 1; }
    100% { transform: scale(1) translateY(0); opacity: 1; }
}

.sk-hint { position: fixed; bottom: 26px; left: 0; right: 0; text-align: center; font-size: 11px; color: rgba(209, 200, 182, 0.4); pointer-events: none; z-index: 501; transition: bottom 0.3s ease; }
/* 有已选手牌时上移到收集区之上，避免与 chip 重叠 */
.sk-hint.raised { bottom: calc(13vh + 22px); }

/* 弹层 */
.sk-overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 80px 16px 24px;
    animation: skFade 0.2s ease-out;
}
@keyframes skFade { from { opacity: 0; } to { opacity: 1; } }
.sk-modal { flex-direction: column; width: min(760px, 94vw); max-height: 100%; border-radius: 8px !important; padding: 0 !important; overflow: hidden; color: #d1c8b6; }
.sk-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid rgba(209, 200, 182, 0.12); flex-shrink: 0; }
.sk-modal-title { font-size: 17px; font-weight: 700; color: #d5c9ac; }
.sk-x { border: 1px solid rgba(209, 200, 182, 0.14); background: transparent; color: rgba(209, 200, 182, 0.6); font-size: 14px; cursor: pointer; padding: 4px 8px; border-radius: 4px; }
.sk-x:hover { border-color: rgba(209, 200, 182, 0.42); color: #f4f1ec; }

.sk-md { padding: 18px 22px 24px; overflow: auto; line-height: 1.65; font-size: 14px; }
.sk-md :deep(h1), .sk-md :deep(h2), .sk-md :deep(h3) { color: #d5c9ac; margin: 16px 0 8px; line-height: 1.3; }
.sk-md :deep(h1) { font-size: 22px; }
.sk-md :deep(h2) { font-size: 18px; }
.sk-md :deep(h3) { font-size: 15px; }
.sk-md :deep(p) { margin: 8px 0; }
.sk-md :deep(ul), .sk-md :deep(ol) { margin: 8px 0 8px 22px; }
.sk-md :deep(li) { margin: 3px 0; }
.sk-md :deep(.md-oli) { margin: 4px 0; padding-left: 2px; }
.sk-md :deep(code) { background: rgba(255, 255, 255, 0.08); padding: 1px 5px; border-radius: 5px; font-family: "Monaco", monospace; font-size: 12px; }
.sk-md :deep(pre) { background: rgba(0, 0, 0, 0.35); padding: 12px 14px; border-radius: 10px; overflow: auto; margin: 10px 0; }
.sk-md :deep(pre code) { background: none; padding: 0; font-size: 12px; line-height: 1.5; }
.sk-md :deep(blockquote) { border-left: 3px solid rgba(245, 222, 179, 0.4); padding-left: 12px; margin: 8px 0; color: rgba(255, 245, 235, 0.7); }
.sk-md :deep(table) { border-collapse: collapse; margin: 10px 0; width: 100%; font-size: 12.5px; }
.sk-md :deep(th), .sk-md :deep(td) { border: 1px solid rgba(255, 240, 225, 0.14); padding: 6px 9px; text-align: left; }
.sk-md :deep(th) { background: rgba(255, 255, 255, 0.05); color: wheat; }
.sk-md :deep(a) { color: #c6b07d; }
.sk-md :deep(hr) { border: none; border-top: 1px solid rgba(255, 240, 225, 0.12); margin: 14px 0; }

.sk-detail { padding: 0 0 18px !important; }
.sk-detail-meta { display: flex; flex-wrap: wrap; gap: 12px; padding: 14px 20px 0; font-size: 12px; color: rgba(209, 200, 182, 0.52); }
.sk-detail-cap { padding: 10px 20px 0; font-size: 14px; line-height: 1.6; color: #d1c8b6; }
.sk-detail-desc { padding: 6px 20px 0; font-size: 13px; line-height: 1.55; color: rgba(209, 200, 182, 0.7); }
.sk-detail .sk-card-tags { padding: 10px 20px 0; }
.sk-struct { padding: 14px 20px 0; }
.sk-struct-title { font-size: 12px; color: rgba(255, 245, 235, 0.5); margin-bottom: 6px; }
.sk-struct-row { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; border-top: 1px solid rgba(255, 240, 225, 0.06); font-size: 12px; }
.sk-struct-kind { font-size: 10px; padding: 1px 6px; border-radius: 6px; flex-shrink: 0; }
.sk-struct-kind.gen { background: rgba(224, 149, 74, 0.25); color: #f0c79a; }
.sk-struct-kind.ref { background: rgba(180, 166, 149, 0.22); color: #d8cdbd; }
.sk-struct-file { font-family: "Monaco", monospace; color: #f3e7d4; }
.sk-struct-gen { color: #ffd98a; font-size: 11px; }
.sk-struct-role { color: rgba(255, 245, 235, 0.55); }
.sk-detail-actions { padding: 18px 20px 0; display: flex; justify-content: flex-end; }
.sk-btn { border: 1px solid rgba(209, 200, 182, 0.28); background: rgba(209, 200, 182, 0.05); color: #d1c8b6; border-radius: 4px; padding: 8px 20px; font-size: 13px; cursor: pointer; transition: background 0.15s, transform 0.15s; }
.sk-btn:hover { transform: translateY(-1px); }
.sk-btn.primary { background: #d5c9ac; color: #040402; border-color: #e1d8c4; font-weight: 700; }
.sk-btn.ghost { background: transparent; opacity: 0.7; }
.sk-btn.ghost:hover { opacity: 1; background: rgba(255, 255, 255, 0.06); }

@media (prefers-reduced-motion: reduce) {
    .sk-card, .sk-card-inner { transition: transform 0.15s linear, box-shadow 0.15s linear, opacity 0.15s linear; }
}
</style>

<template>
  <div class="skills-page">
    <!-- 顶部标题 -->
    <div class="sk-head">
      <div class="sk-title">技能库 · Skill Library</div>
      <div class="sk-sub">
        <template v-if="skillsState.loading">正在从社区仓库加载…</template>
        <template v-else-if="skillsState.error">加载失败：{{ skillsState.error }}（可稍后刷新）</template>
        <template v-else>
          像安排手牌一样挑选能力 · 已收录 {{ skillsState.all.length }} 个 · 已选 {{ selected.length }}
        </template>
      </div>
    </div>

    <!-- 卡牌台（扇形手牌） -->
    <div class="sk-stage" ref="stageRef">
      <div
        v-for="(c, idx) in cards"
        :key="c.id"
        class="sk-card"
        :style="outerStyle(c, idx)"
      >
        <div
          class="sk-card-inner"
          :class="{ active: activeId === c.id, readme: c.kind === 'readme', selected: c.kind === 'skill' && isSelected(c.brief!.id) }"
          :style="innerStyle(c, idx)"
          @click="openCard(c)"
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
          </div>
          <div v-if="c.kind === 'skill' && isSelected(c.brief!.id)" class="sk-card-badge">已选</div>
        </div>
      </div>
    </div>

    <div class="sk-hint">移动鼠标聚焦 · 按 Space 或点击查看详情</div>

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
import { ref, computed, onMounted, onUnmounted } from "vue";
import { skillsState, selected, fetchSkills, isSelected, toggleSkill } from "../logic/skills";
import type { SkillBrief } from "../logic/skills";
import { renderMarkdown } from "../logic/miniMarkdown";

type SkCard = {
    id: string;
    kind: "readme" | "skill";
    label: string;
    sub: string;
    tags: string[];
    color: string;
    brief?: SkillBrief;
};

const palette: Record<string, { bg: string; text: string; dot: string }> = {
    cocoa:  { bg: "#6f4322", text: "#f3e2cf", dot: "rgba(255,240,222,.5)" },
    wheat:  { bg: "#e9c88f", text: "#5a4226", dot: "rgba(120,78,38,.5)"   },
    orange: { bg: "#e0954a", text: "#fff7ec", dot: "rgba(255,250,240,.6)" },
    brown:  { bg: "#9a6230", text: "#f8ead8", dot: "rgba(255,245,230,.55)"},
    cream:  { bg: "#f6ece0", text: "#5a4632", dot: "rgba(150,100,60,.5)"  },
    gray:   { bg: "#b4a695", text: "#403728", dot: "rgba(255,250,242,.6)" },
};
const skillColors = ["wheat", "orange", "brown", "cream", "gray"];

const baseW = 184, baseH = 256;

const cards = computed<SkCard[]>(() => {
    const list: SkCard[] = [{
        id: "__readme__", kind: "readme", color: "cocoa",
        label: "README", sub: "技能库说明 · 点击查看", tags: [],
    }];
    skillsState.all.forEach((b, i) => {
        list.push({
            id: b.id, kind: "skill", brief: b, color: skillColors[i % skillColors.length],
            label: b.name || b.id,
            sub: b.capability || b.description || "",
            tags: (b.tags || []).slice(0, 3),
        });
    });
    return list;
});

// ── 扇形布局（移植 ClarifyCards）──
const n = computed(() => cards.value.length);
const globalScale = computed(() => Math.max(0.58, Math.min(1.0, 1.0 - (n.value - 5) * 0.045)));
const step = computed(() => baseW * globalScale.value * 0.5);

const slots = computed(() => {
    const cnt = n.value, mid = (cnt - 1) / 2;
    const spread = Math.min(5.5, 24 / Math.max(cnt, 1));
    const map: Record<string, { x: number; rot: number; arc: number }> = {};
    cards.value.forEach((c, idx) => {
        const d = idx - mid;
        map[c.id] = { x: d * step.value, rot: d * spread, arc: d * d * 1.6 };
    });
    return map;
});

const activeId = ref<string | null>(null);
const stageRef = ref<HTMLElement | null>(null);

function geom(card: SkCard, idx: number) {
    const slot = slots.value[card.id];
    if (!slot) return { x: 0, y: 0, rot: 0, scale: 1, z: 1 };
    const bs = globalScale.value;
    const active = activeId.value === card.id;
    let rot = slot.rot, y = slot.arc, scale = bs, z = idx + 1;
    if (active) { rot = 0; y = slot.arc - 46; scale = bs * 1.16; z = 200; }
    return { x: slot.x, y, rot, scale, z };
}
function outerStyle(card: SkCard, idx: number) {
    const g = geom(card, idx);
    return {
        width: baseW + "px", height: baseH + "px", zIndex: g.z,
        transform: `translate(-50%,-50%) translate(${g.x}px, ${g.y}px)`,
    };
}
function innerStyle(card: SkCard, idx: number) {
    const g = geom(card, idx);
    return {
        background: palette[card.color].bg, color: palette[card.color].text,
        transform: `rotate(${g.rot}deg) scale(${g.scale})`,
    };
}
const dotColor = (card: SkCard) => palette[card.color].dot;

// 悬停聚焦：鼠标 x 选最近卡
function onMove(e: MouseEvent) {
    const el = stageRef.value; if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = e.clientX - (r.left + r.width / 2), cy = e.clientY - (r.top + r.height / 2);
    if (Math.abs(cy) > baseH * globalScale.value * 0.6 + 80) { activeId.value = null; return; }
    let best: string | null = null, bestDist = Infinity;
    for (const c of cards.value) {
        const dist = Math.abs(cx - slots.value[c.id].x);
        if (dist < bestDist) { bestDist = dist; best = c.id; }
    }
    activeId.value = bestDist <= step.value + baseW * globalScale.value * 0.5 ? best : null;
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
    // 延续 mermaid 卡片操作逻辑：聚焦某卡后按 Space 查看详情（再按 / Esc 关闭）
    if (e.key === " " || e.code === "Space") {
        if (readmeOpen.value || detail.value) { e.preventDefault(); readmeOpen.value = false; detail.value = null; return; }
        const c = cards.value.find((x) => x.id === activeId.value);
        if (c) { e.preventDefault(); openCard(c); }
    }
}

onMounted(() => {
    fetchSkills();
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("keydown", onKey);
});
onUnmounted(() => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("keydown", onKey);
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
.sk-title {
    font-family: "ZhuoKai", sans-serif;
    font-size: 24px;
    color: #f3e7d4;
    text-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
}
.sk-sub {
    font-size: 13px;
    color: rgba(255, 245, 235, 0.5);
    letter-spacing: 0.03em;
}

.sk-stage {
    position: absolute;
    left: 0;
    right: 0;
    top: 54%;
    height: 0;
}

.sk-card {
    position: absolute;
    left: 50%;
    top: 0;
    will-change: transform;
    transition: transform 0.5s cubic-bezier(.34, 1.56, .64, 1);
}
.sk-card-inner {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 18px;
    padding: 16px 15px;
    display: flex;
    flex-direction: column;
    cursor: pointer;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    background-image: linear-gradient(155deg, rgba(255, 255, 255, .18), rgba(0, 0, 0, .06));
    transition: transform 0.5s cubic-bezier(.34, 1.56, .64, 1), box-shadow 0.35s ease;
}
.sk-card-inner.active { box-shadow: 0 12px 44px rgba(255, 180, 120, .28), 0 8px 24px rgba(0, 0, 0, .5); }
.sk-card-inner.selected { box-shadow: 0 12px 44px rgba(143, 209, 106, .35), 0 8px 24px rgba(0, 0, 0, .5); }
.sk-card-inner.readme { background-image: linear-gradient(155deg, rgba(255, 255, 255, .1), rgba(0, 0, 0, .14)); }

.sk-dots { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

.sk-card-top {
    position: relative;
    z-index: 2;
    font-size: 11px;
    opacity: 0.7;
    letter-spacing: 0.05em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.sk-card-body {
    position: relative;
    z-index: 2;
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 7px;
}
.sk-card-label {
    font-size: 18px;
    font-weight: 700;
    line-height: 1.25;
    word-break: break-word;
}
.sk-card-desc {
    font-size: 12px;
    line-height: 1.4;
    opacity: 0.78;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.sk-card-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.sk-tag {
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.18);
    opacity: 0.85;
}
.sk-card-badge {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 3;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 8px;
    background: rgba(60, 120, 40, 0.85);
    color: #eaffd8;
}

.sk-empty {
    position: fixed;
    top: 50%;
    left: 0;
    right: 0;
    text-align: center;
    color: rgba(255, 245, 235, 0.45);
    font-size: 14px;
    pointer-events: none;
}
.sk-hint {
    position: fixed;
    bottom: 26px;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 12px;
    color: rgba(255, 245, 235, 0.4);
    pointer-events: none;
}

/* 弹层 */
.sk-overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: rgba(8, 6, 4, 0.78);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 80px 16px 24px;
    animation: skFade 0.2s ease-out;
}
@keyframes skFade { from { opacity: 0; } to { opacity: 1; } }
.sk-modal {
    flex-direction: column;
    width: min(760px, 94vw);
    max-height: 100%;
    border-radius: 18px !important;
    padding: 0 !important;
    overflow: hidden;
    color: #f3e7d4;
}
.sk-modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid rgba(255, 240, 225, 0.12);
    flex-shrink: 0;
}
.sk-modal-title { font-size: 18px; font-weight: 700; color: wheat; }
.sk-x {
    border: none;
    background: transparent;
    color: rgba(255, 245, 235, 0.6);
    font-size: 16px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 8px;
}
.sk-x:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }

.sk-md { padding: 18px 22px 24px; overflow: auto; line-height: 1.65; font-size: 14px; }
.sk-md :deep(h1), .sk-md :deep(h2), .sk-md :deep(h3) { color: wheat; margin: 16px 0 8px; line-height: 1.3; }
.sk-md :deep(h1) { font-size: 22px; }
.sk-md :deep(h2) { font-size: 18px; }
.sk-md :deep(h3) { font-size: 15px; }
.sk-md :deep(p) { margin: 8px 0; }
.sk-md :deep(ul), .sk-md :deep(ol) { margin: 8px 0 8px 22px; }
.sk-md :deep(li) { margin: 3px 0; }
.sk-md :deep(code) { background: rgba(255, 255, 255, 0.08); padding: 1px 5px; border-radius: 5px; font-family: "Monaco", monospace; font-size: 12px; }
.sk-md :deep(pre) { background: rgba(0, 0, 0, 0.35); padding: 12px 14px; border-radius: 10px; overflow: auto; margin: 10px 0; }
.sk-md :deep(pre code) { background: none; padding: 0; font-size: 12px; line-height: 1.5; }
.sk-md :deep(blockquote) { border-left: 3px solid rgba(245, 222, 179, 0.4); padding-left: 12px; margin: 8px 0; color: rgba(255, 245, 235, 0.7); }
.sk-md :deep(table) { border-collapse: collapse; margin: 10px 0; width: 100%; font-size: 12.5px; }
.sk-md :deep(th), .sk-md :deep(td) { border: 1px solid rgba(255, 240, 225, 0.14); padding: 6px 9px; text-align: left; }
.sk-md :deep(th) { background: rgba(255, 255, 255, 0.05); color: wheat; }
.sk-md :deep(a) { color: #ffd98a; }
.sk-md :deep(hr) { border: none; border-top: 1px solid rgba(255, 240, 225, 0.12); margin: 14px 0; }

.sk-detail { padding: 0 0 18px !important; }
.sk-detail-meta { display: flex; flex-wrap: wrap; gap: 12px; padding: 14px 20px 0; font-size: 12px; color: rgba(255, 245, 235, 0.55); }
.sk-detail-cap { padding: 10px 20px 0; font-size: 14px; line-height: 1.6; color: #f3e7d4; }
.sk-detail-desc { padding: 6px 20px 0; font-size: 13px; line-height: 1.55; color: rgba(255, 245, 235, 0.7); }
.sk-detail .sk-card-tags { padding: 10px 20px 0; }
.sk-struct { padding: 14px 20px 0; }
.sk-struct-title { font-size: 12px; color: rgba(255, 245, 235, 0.5); margin-bottom: 6px; }
.sk-struct-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 0;
    border-top: 1px solid rgba(255, 240, 225, 0.06);
    font-size: 12px;
}
.sk-struct-kind { font-size: 10px; padding: 1px 6px; border-radius: 6px; flex-shrink: 0; }
.sk-struct-kind.gen { background: rgba(224, 149, 74, 0.25); color: #f0c79a; }
.sk-struct-kind.ref { background: rgba(180, 166, 149, 0.22); color: #d8cdbd; }
.sk-struct-file { font-family: "Monaco", monospace; color: #f3e7d4; }
.sk-struct-gen { color: #ffd98a; font-size: 11px; }
.sk-struct-role { color: rgba(255, 245, 235, 0.55); }

.sk-detail-actions { padding: 18px 20px 0; display: flex; justify-content: flex-end; }
.sk-btn {
    border: 1px solid rgba(255, 240, 225, 0.28);
    background: rgba(255, 255, 255, 0.08);
    color: #f3e7d4;
    border-radius: 11px;
    padding: 9px 22px;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.15s, transform 0.15s;
}
.sk-btn:hover { transform: translateY(-1px); }
.sk-btn.primary { background: wheat; color: #1c1812; border-color: wheat; font-weight: 700; }
.sk-btn.ghost { background: transparent; opacity: 0.7; }
.sk-btn.ghost:hover { opacity: 1; background: rgba(255, 255, 255, 0.06); }

@media (prefers-reduced-motion: reduce) {
    .sk-card { transition: transform 0.15s linear; }
}
</style>

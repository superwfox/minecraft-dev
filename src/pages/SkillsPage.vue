<template>
  <div class="skills-page">
    <header class="sk-head">
      <div>
        <div class="sk-kicker">capability archive / {{ skillsState.all.length }}</div>
        <h1 class="sk-title">skill library</h1>
        <p class="sk-sub">挑选需要的能力，并决定它们注入生成上下文的先后顺序。</p>
      </div>
      <div class="sk-contrib"><SkillSubmit/></div>
    </header>

    <main class="sk-shell">
      <section class="sk-panel sk-library" aria-labelledby="available-skills-title">
        <div class="sk-panel-head library-head">
          <div>
            <span class="sk-panel-index">01</span>
            <h2 id="available-skills-title">可用技能</h2>
          </div>
          <label class="sk-search-wrap">
            <span aria-hidden="true">⌕</span>
            <input v-model="query" type="search" placeholder="搜索名称、能力或标签" aria-label="搜索技能">
          </label>
        </div>

        <div v-if="skillsState.loading" class="sk-state">正在从社区仓库加载…</div>
        <div v-else-if="skillsState.error" class="sk-state error">
          <span>加载失败：{{ skillsState.error }}</span>
          <button type="button" @click="fetchSkills(true)">重试</button>
        </div>

        <div v-else class="sk-grid">
          <button type="button" class="sk-card readme-card" @click="readmeOpen = true">
            <span class="sk-card-topline">
              <span>00 / README</span>
              <span aria-hidden="true">↗</span>
            </span>
            <span class="sk-readme-mark">R</span>
            <span class="sk-card-copy">
              <strong>技能库说明</strong>
              <span>查看目录规范、能力注入方式与社区贡献说明。</span>
            </span>
          </button>

          <article
            v-for="(skill, index) in filteredSkills"
            :key="skill.id"
            class="sk-card skill-card"
            :class="{ selected: isSelected(skill.id) }"
          >
            <button type="button" class="sk-card-main" @click="detail = skill">
              <span class="sk-card-topline">
                <span>{{ String(index + 1).padStart(2, '0') }} / {{ skill.author || 'community' }}</span>
                <span>{{ isSelected(skill.id) ? 'selected' : 'details ↗' }}</span>
              </span>
              <span class="sk-card-copy">
                <strong>{{ skill.name || skill.id }}</strong>
                <span>{{ skill.capability || skill.description || '暂无能力说明' }}</span>
              </span>
              <span v-if="skill.tags?.length" class="sk-card-tags">
                <span v-for="tag in skill.tags.slice(0, 4)" :key="tag" class="sk-tag">{{ tag }}</span>
              </span>
            </button>
            <button
              type="button"
              class="sk-card-toggle"
              :class="{ selected: isSelected(skill.id) }"
              :aria-pressed="isSelected(skill.id)"
              @click="toggleSkill(skill.id)"
            >
              <span>{{ isSelected(skill.id) ? '移出技能' : '加入技能' }}</span>
              <span aria-hidden="true">{{ isSelected(skill.id) ? '−' : '+' }}</span>
            </button>
          </article>

          <div v-if="filteredSkills.length === 0" class="sk-state empty">
            {{ query ? '没有匹配的技能' : '仓库暂无技能' }}
          </div>
        </div>
      </section>

      <aside class="sk-panel sk-selection" aria-labelledby="selected-skills-title">
        <div class="sk-panel-head selection-head">
          <div>
            <span class="sk-panel-index">02</span>
            <h2 id="selected-skills-title">已选顺序</h2>
          </div>
          <span class="sk-count">{{ String(chosen.length).padStart(2, '0') }}</span>
        </div>

        <p class="sk-selection-note">靠前的技能会更早进入生成上下文。</p>

        <ol v-if="chosen.length" class="sk-selected-list">
          <li v-for="(skill, index) in chosen" :key="skill.id" class="sk-selected-item">
            <span class="sk-order">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="sk-selected-name">{{ skill.name || skill.id }}</span>
            <span class="sk-selected-actions">
              <button type="button" :disabled="index === 0" aria-label="提高优先级" @click="moveSkill(index, index - 1)">↑</button>
              <button type="button" :disabled="index === chosen.length - 1" aria-label="降低优先级" @click="moveSkill(index, index + 1)">↓</button>
              <button type="button" aria-label="移除技能" @click="removeSkill(skill.id)">×</button>
            </span>
          </li>
        </ol>
        <div v-else class="sk-selection-empty">
          <span class="sk-empty-glyph">+</span>
          <span>从左侧加入技能</span>
        </div>

        <router-link to="/chat" class="sk-chat-link" :class="{ disabled: !chosen.length }">
          <span>带到聊天栏</span>
          <span aria-hidden="true">→</span>
        </router-link>
      </aside>
    </main>

    <Teleport to="body">
      <div v-if="readmeOpen" class="sk-overlay" @click.self="readmeOpen = false">
        <div class="sk-modal sk-readme" role="dialog" aria-modal="true" aria-label="技能库说明">
          <div class="sk-modal-head">
            <div>
              <span class="sk-modal-kicker">README / ARCHIVE</span>
              <span class="sk-modal-title">技能库说明</span>
            </div>
            <button class="sk-x" aria-label="关闭" @click="readmeOpen = false">✕</button>
          </div>
          <div class="sk-md" v-html="readmeHtml"></div>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="detail" class="sk-overlay" @click.self="detail = null">
        <div class="sk-modal sk-detail" role="dialog" aria-modal="true" :aria-label="detail.name || detail.id">
          <div class="sk-modal-head">
            <div>
              <span class="sk-modal-kicker">SKILL / {{ detail.id }}</span>
              <span class="sk-modal-title">{{ detail.name || detail.id }}</span>
            </div>
            <button class="sk-x" aria-label="关闭" @click="detail = null">✕</button>
          </div>
          <div class="sk-detail-body">
            <div class="sk-detail-meta">
              <span v-if="detail.author">作者 {{ detail.author }}</span>
              <span v-if="detail.version">v{{ detail.version }}</span>
              <span v-if="detail.coreTypes?.length">{{ detail.coreTypes.join(' / ') }}</span>
            </div>
            <p v-if="detail.capability" class="sk-detail-cap">{{ detail.capability }}</p>
            <p v-if="detail.description" class="sk-detail-desc">{{ detail.description }}</p>
            <div v-if="detail.tags?.length" class="sk-card-tags detail-tags">
              <span v-for="tag in detail.tags" :key="tag" class="sk-tag">{{ tag }}</span>
            </div>

            <div v-if="detail.structure?.length" class="sk-struct">
              <div class="sk-struct-title">文件结构</div>
              <div v-for="(entry, index) in detail.structure" :key="index" class="sk-struct-row">
                <span class="sk-struct-kind" :class="entry.kind">{{ entry.kind }}</span>
                <span class="sk-struct-file">{{ entry.file }}</span>
                <span v-if="entry.fileGen" class="sk-struct-gen">{{ entry.fileGen }}</span>
                <span v-if="entry.role" class="sk-struct-role">{{ entry.role }}</span>
              </div>
            </div>
          </div>
          <div class="sk-detail-actions">
            <button type="button" class="sk-detail-toggle" :class="{ selected: isSelected(detail.id) }" @click="toggleSkill(detail.id)">
              {{ isSelected(detail.id) ? '移出技能' : '加入技能' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
    fetchSkills,
    isSelected,
    moveSkill,
    removeSkill,
    selectedBriefs,
    skillsState,
    toggleSkill,
} from "../logic/skills";
import type { SkillBrief } from "../logic/skills";
import { renderMarkdown } from "../logic/miniMarkdown";
import SkillSubmit from "../components/SkillSubmit.vue";

const query = ref("");
const readmeOpen = ref(false);
const detail = ref<SkillBrief | null>(null);

const chosen = computed(() => selectedBriefs());
const filteredSkills = computed(() => {
    const value = query.value.trim().toLocaleLowerCase();
    if (!value) return skillsState.all;
    return skillsState.all.filter((skill) => [
        skill.name,
        skill.id,
        skill.author,
        skill.capability,
        skill.description,
        ...(skill.tags || []),
    ].some((field) => field?.toLocaleLowerCase().includes(value)));
});
const readmeHtml = computed(() => renderMarkdown(skillsState.readme) || "<p>（暂无说明）</p>");

function onKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    readmeOpen.value = false;
    detail.value = null;
}

onMounted(() => {
    fetchSkills();
    window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<style scoped>
.skills-page {
    min-height: 100vh;
    padding: 132px 24px 72px;
    background: #000;
    color: #e8e3d9;
    user-select: none;
}

.sk-head {
    width: min(1120px, 100%);
    margin: 0 auto 26px;
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 24px;
}
.sk-kicker,
.sk-panel-index,
.sk-modal-kicker {
    display: block;
    color: rgba(232, 227, 217, 0.42);
    font: 10px/1.2 "Monaco", monospace;
    letter-spacing: 0.12em;
    text-transform: uppercase;
}
.sk-title {
    margin-top: 8px;
    color: #eee9df;
    font: 34px/1 "MinecrafterAlt", sans-serif;
    letter-spacing: 0.015em;
    text-transform: lowercase;
}
.sk-sub {
    margin-top: 10px;
    color: rgba(232, 227, 217, 0.56);
    font-size: 13px;
    line-height: 1.6;
}
.sk-contrib { flex: 0 0 auto; }

.sk-shell {
    width: min(1120px, 100%);
    margin: 0 auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 302px;
    gap: 16px;
    align-items: start;
}
.sk-panel {
    overflow: hidden;
    border: 1px solid rgba(232, 227, 217, 0.17);
    border-top-color: rgba(248, 245, 238, 0.27);
    border-radius: 18px;
    background: rgba(5, 5, 3, 0.52);
    backdrop-filter: blur(26px) saturate(88%);
    -webkit-backdrop-filter: blur(26px) saturate(88%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035), 0 28px 70px rgba(0, 0, 0, 0.24);
}
.sk-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 18px 20px;
    border-bottom: 1px solid rgba(232, 227, 217, 0.1);
}
.sk-panel-head > div { display: flex; align-items: baseline; gap: 12px; }
.sk-panel-head h2 {
    color: #e8e3d9;
    font-size: 14px;
    font-weight: 560;
    letter-spacing: 0.04em;
}

.sk-search-wrap {
    width: min(280px, 46%);
    height: 34px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 11px;
    border: 1px solid rgba(232, 227, 217, 0.14);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.2);
    color: rgba(232, 227, 217, 0.42);
}
.sk-search-wrap:focus-within { border-color: rgba(238, 233, 223, 0.42); }
.sk-search-wrap input {
    width: 100%;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: #eee9df;
    font: 12px/1 system-ui, "Noto Sans SC", sans-serif;
}
.sk-search-wrap input::placeholder { color: rgba(232, 227, 217, 0.32); }

.sk-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(245px, 1fr));
    gap: 10px;
    padding: 10px;
}
.sk-card {
    min-width: 0;
    min-height: 222px;
    border: 1px solid rgba(232, 227, 217, 0.12);
    border-radius: 12px;
    background: rgba(232, 227, 217, 0.018);
    color: #e8e3d9;
    text-align: left;
    transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease;
}
.sk-card:hover {
    transform: translateY(-2px);
    border-color: rgba(232, 227, 217, 0.3);
    background: rgba(232, 227, 217, 0.035);
}
.sk-card.selected {
    border-color: rgba(238, 233, 223, 0.48);
    background: rgba(232, 227, 217, 0.045);
}
.readme-card {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 16px;
    cursor: pointer;
    overflow: hidden;
    border-style: dashed;
}
.readme-card::after {
    content: "";
    position: absolute;
    width: 180px;
    height: 180px;
    right: -82px;
    bottom: -88px;
    border: 1px solid rgba(232, 227, 217, 0.1);
    border-radius: 50%;
    box-shadow: 0 0 0 22px rgba(232, 227, 217, 0.018), 0 0 0 44px rgba(232, 227, 217, 0.012);
}
.sk-readme-mark {
    color: rgba(232, 227, 217, 0.11);
    font: 76px/0.9 Georgia, serif;
}
.skill-card { display: flex; flex-direction: column; }
.sk-card-main {
    flex: 1;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 16px;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
}
.sk-card-topline {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: rgba(232, 227, 217, 0.4);
    font: 9px/1.3 "Monaco", monospace;
    letter-spacing: 0.07em;
    text-transform: uppercase;
}
.sk-card-copy {
    display: flex;
    flex-direction: column;
    gap: 9px;
    margin-top: auto;
    position: relative;
    z-index: 1;
}
.sk-card-copy strong {
    color: #eee9df;
    font-size: 18px;
    font-weight: 560;
    line-height: 1.28;
}
.sk-card-copy > span {
    color: rgba(232, 227, 217, 0.56);
    font-size: 12px;
    line-height: 1.55;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.sk-card-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.sk-tag {
    padding: 3px 7px;
    border: 1px solid rgba(232, 227, 217, 0.12);
    border-radius: 999px;
    color: rgba(232, 227, 217, 0.5);
    font: 9px/1 "Monaco", monospace;
}
.sk-card-toggle {
    min-height: 38px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 14px;
    border: 0;
    border-top: 1px solid rgba(232, 227, 217, 0.1);
    border-radius: 0 0 11px 11px;
    background: rgba(232, 227, 217, 0.025);
    color: rgba(232, 227, 217, 0.72);
    font-size: 11px;
    cursor: pointer;
}
.sk-card-toggle:hover { background: rgba(232, 227, 217, 0.07); color: #fff; }
.sk-card-toggle.selected { background: #e8e3d9; color: #070706; }

.sk-selection { position: sticky; top: 112px; }
.sk-count {
    color: rgba(232, 227, 217, 0.48);
    font: 12px/1 "Monaco", monospace;
}
.sk-selection-note {
    padding: 14px 16px 4px;
    color: rgba(232, 227, 217, 0.42);
    font-size: 11px;
    line-height: 1.55;
}
.sk-selected-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 10px;
}
.sk-selected-item {
    min-height: 48px;
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) auto;
    align-items: center;
    gap: 7px;
    padding: 7px 7px 7px 10px;
    border: 1px solid rgba(232, 227, 217, 0.12);
    border-radius: 8px;
    background: rgba(232, 227, 217, 0.025);
}
.sk-order { color: rgba(232, 227, 217, 0.44); font: 10px/1 "Monaco", monospace; }
.sk-selected-name { overflow: hidden; color: #e8e3d9; font-size: 11px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.sk-selected-actions { display: flex; gap: 2px; }
.sk-selected-actions button {
    width: 24px;
    height: 26px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: rgba(232, 227, 217, 0.48);
    cursor: pointer;
}
.sk-selected-actions button:hover:not(:disabled) { background: rgba(232, 227, 217, 0.08); color: #fff; }
.sk-selected-actions button:disabled { opacity: 0.14; cursor: default; }
.sk-selection-empty {
    min-height: 150px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: rgba(232, 227, 217, 0.34);
    font-size: 11px;
}
.sk-empty-glyph {
    width: 38px;
    height: 38px;
    display: grid;
    place-items: center;
    border: 1px dashed rgba(232, 227, 217, 0.2);
    border-radius: 50%;
    font-size: 18px;
}
.sk-chat-link {
    min-height: 42px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 10px;
    padding: 0 14px;
    border: 1px solid #f2eee6;
    border-bottom-color: #817d74;
    border-radius: 8px;
    background: #e8e3d9;
    color: #070706;
    box-shadow: 0 2px 0 #504d47, inset 0 1px 0 #fff;
    font-size: 12px;
    font-weight: 650;
    text-decoration: none;
}
.sk-chat-link:active { transform: translateY(1px); box-shadow: 0 1px 0 #504d47; }
.sk-chat-link.disabled { opacity: 0.34; pointer-events: none; }

.sk-state {
    grid-column: 1 / -1;
    min-height: 190px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: rgba(232, 227, 217, 0.42);
    font-size: 12px;
}
.sk-state button {
    border: 1px solid rgba(232, 227, 217, 0.2);
    border-radius: 6px;
    background: transparent;
    color: #e8e3d9;
    padding: 6px 10px;
    cursor: pointer;
}

.sk-overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 108px 20px 28px;
    background: rgba(0, 0, 0, 0.58);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
}
.sk-modal {
    width: min(760px, 100%);
    max-height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid rgba(232, 227, 217, 0.2);
    border-top-color: rgba(248, 245, 238, 0.3);
    border-radius: 18px;
    background: rgba(5, 5, 3, 0.88);
    backdrop-filter: blur(30px) saturate(90%);
    -webkit-backdrop-filter: blur(30px) saturate(90%);
    box-shadow: 0 34px 90px rgba(0, 0, 0, 0.66), inset 0 1px 0 rgba(255, 255, 255, 0.04);
}
.sk-modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 18px 20px;
    border-bottom: 1px solid rgba(232, 227, 217, 0.1);
}
.sk-modal-head > div { min-width: 0; }
.sk-modal-title {
    display: block;
    margin-top: 6px;
    overflow: hidden;
    color: #eee9df;
    font-size: 17px;
    font-weight: 560;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.sk-x {
    width: 32px;
    height: 32px;
    flex: 0 0 auto;
    border: 1px solid rgba(232, 227, 217, 0.16);
    border-radius: 7px;
    background: transparent;
    color: rgba(232, 227, 217, 0.56);
    cursor: pointer;
}
.sk-x:hover { border-color: rgba(232, 227, 217, 0.4); color: #fff; }
.sk-md {
    padding: 20px 22px 26px;
    overflow: auto;
    color: rgba(232, 227, 217, 0.72);
    font-size: 13px;
    line-height: 1.7;
    user-select: text;
}
.sk-md :deep(h1), .sk-md :deep(h2), .sk-md :deep(h3) { margin: 18px 0 8px; color: #eee9df; line-height: 1.3; }
.sk-md :deep(h1) { font-size: 22px; }
.sk-md :deep(h2) { font-size: 18px; }
.sk-md :deep(h3) { font-size: 15px; }
.sk-md :deep(p) { margin: 8px 0; }
.sk-md :deep(ul), .sk-md :deep(ol) { margin: 8px 0 8px 22px; }
.sk-md :deep(code) { padding: 2px 5px; border-radius: 4px; background: rgba(255, 255, 255, 0.07); font-family: "Monaco", monospace; font-size: 11px; }
.sk-md :deep(pre) { margin: 10px 0; padding: 12px 14px; overflow: auto; border: 1px solid rgba(232, 227, 217, 0.1); border-radius: 8px; background: rgba(0, 0, 0, 0.3); }
.sk-md :deep(pre code) { padding: 0; background: none; }
.sk-md :deep(a) { color: #eee9df; }
.sk-md :deep(blockquote) { margin: 10px 0; padding-left: 12px; border-left: 2px solid rgba(232, 227, 217, 0.28); color: rgba(232, 227, 217, 0.56); }
.sk-md :deep(table) { width: 100%; margin: 10px 0; border-collapse: collapse; font-size: 12px; }
.sk-md :deep(th), .sk-md :deep(td) { padding: 7px 9px; border: 1px solid rgba(232, 227, 217, 0.12); text-align: left; }

.sk-detail-body { padding: 18px 20px 6px; overflow: auto; user-select: text; }
.sk-detail-meta { display: flex; flex-wrap: wrap; gap: 12px; color: rgba(232, 227, 217, 0.42); font: 10px/1.4 "Monaco", monospace; }
.sk-detail-cap { margin-top: 16px; color: #e8e3d9; font-size: 14px; line-height: 1.65; }
.sk-detail-desc { margin-top: 10px; color: rgba(232, 227, 217, 0.62); font-size: 13px; line-height: 1.65; }
.detail-tags { margin-top: 14px; }
.sk-struct { margin-top: 20px; }
.sk-struct-title { margin-bottom: 7px; color: rgba(232, 227, 217, 0.46); font-size: 11px; }
.sk-struct-row {
    display: grid;
    grid-template-columns: auto minmax(120px, auto) minmax(0, 1fr);
    align-items: baseline;
    gap: 8px;
    padding: 7px 0;
    border-top: 1px solid rgba(232, 227, 217, 0.08);
    font-size: 11px;
}
.sk-struct-kind { padding: 2px 6px; border: 1px solid rgba(232, 227, 217, 0.15); border-radius: 999px; color: rgba(232, 227, 217, 0.55); font-size: 9px; }
.sk-struct-file { color: #e8e3d9; font-family: "Monaco", monospace; }
.sk-struct-gen, .sk-struct-role { color: rgba(232, 227, 217, 0.48); }
.sk-detail-actions { display: flex; justify-content: flex-end; padding: 14px 20px 18px; border-top: 1px solid rgba(232, 227, 217, 0.1); }
.sk-detail-toggle {
    min-width: 112px;
    height: 34px;
    border: 1px solid #f2eee6;
    border-bottom-color: #817d74;
    border-radius: 7px;
    background: #e8e3d9;
    color: #070706;
    box-shadow: 0 2px 0 #504d47, inset 0 1px 0 #fff;
    font-size: 12px;
    font-weight: 650;
    cursor: pointer;
}
.sk-detail-toggle.selected { border-color: rgba(232, 227, 217, 0.2); background: transparent; color: #e8e3d9; box-shadow: none; }

button:focus-visible,
a:focus-visible,
input:focus-visible { outline: 2px solid rgba(238, 233, 223, 0.72); outline-offset: 3px; }

@media (max-width: 860px) {
    .skills-page { padding: 106px 16px 56px; }
    .sk-head { align-items: center; }
    .sk-shell { grid-template-columns: 1fr; }
    .sk-selection { position: static; }
}

@media (max-width: 560px) {
    .sk-head { align-items: flex-start; flex-direction: column; }
    .sk-title { font-size: 28px; }
    .library-head { align-items: flex-start; flex-direction: column; }
    .sk-search-wrap { width: 100%; }
    .sk-grid { grid-template-columns: 1fr; }
    .sk-card { min-height: 204px; }
    .sk-overlay { padding: 90px 10px 14px; }
    .sk-struct-row { grid-template-columns: auto minmax(0, 1fr); }
    .sk-struct-gen, .sk-struct-role { grid-column: 2; }
}

@media (prefers-reduced-motion: reduce) {
    .sk-card { transition: none; }
}
</style>

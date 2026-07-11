<template>
  <div class="tray-root">
    <div v-if="trayOpen" class="tray-scrim" @click="closeTray"></div>

    <transition name="tray-pop">
      <aside v-if="trayOpen" class="tray" role="dialog" aria-modal="true" aria-label="选择技能">
        <div class="tray-head">
          <div>
            <div class="tray-title">select skills</div>
            <div class="tray-summary">按顺序注入生成上下文 · {{ chosen.length }} 已选</div>
          </div>
          <button type="button" class="tray-x" aria-label="关闭技能选择" @click="closeTray">✕</button>
        </div>

        <!-- 已选区（可拖拽排序） -->
        <div class="tray-section chosen-section">
          <div class="tray-section-title">已选技能 <span>靠前优先</span></div>
          <div v-if="!chosen.length" class="tray-empty">尚未选择技能，下方点击即可加入</div>
          <ul v-else class="tray-list">
            <li v-for="(b, i) in chosen" :key="b.id"
                class="tray-chip" draggable="true"
                :class="{ dragging: dragIndex === i }"
                @dragstart="onDragStart(i)"
                @dragover.prevent="onDragOver(i)"
                @dragend="dragIndex = -1"
                @drop="onDrop(i)">
              <span class="tray-grip">⠿</span>
              <span class="tray-order">{{ String(i + 1).padStart(2, '0') }}</span>
              <span class="tray-chip-name">{{ b.name || b.id }}</span>
              <button type="button" class="tray-move" :disabled="i === 0" aria-label="提高优先级" @click="moveSkill(i, i - 1)">↑</button>
              <button type="button" class="tray-move" :disabled="i === chosen.length - 1" aria-label="降低优先级" @click="moveSkill(i, i + 1)">↓</button>
              <button type="button" class="tray-rm" @click="removeSkill(b.id)" title="移出">✕</button>
            </li>
          </ul>
        </div>

        <!-- 全部 skill（勾选增减） -->
        <div class="tray-section grow">
          <div class="tray-section-title">
            可用技能
            <span v-if="skillsState.loading" class="tray-loading">加载中…</span>
          </div>
          <label class="tray-search-wrap">
            <span class="tray-search-icon">⌕</span>
            <input v-model="query" class="tray-search" type="search" placeholder="搜索名称、能力或标签" aria-label="搜索技能">
          </label>
          <div v-if="skillsState.error" class="tray-error">
            <span>加载失败：{{ skillsState.error }}</span>
            <button type="button" @click="fetchSkills(true)">重试</button>
          </div>
          <div v-else-if="!skillsState.loading && filteredSkills.length === 0" class="tray-empty">
            {{ query ? '没有匹配的技能' : '仓库暂无技能' }}
          </div>
          <ul v-else class="tray-list available-list">
            <li v-for="b in filteredSkills" :key="b.id">
              <button type="button" class="tray-item" :class="{ on: isSelected(b.id) }"
                      :aria-pressed="isSelected(b.id)" @click="toggleSkill(b.id)">
                <span class="tray-check">{{ isSelected(b.id) ? '✓' : '' }}</span>
                <span class="tray-item-body">
                  <span class="tray-item-name">{{ b.name || b.id }}</span>
                  <span class="tray-item-cap">{{ b.capability || b.description || '暂无能力说明' }}</span>
                </span>
              </button>
            </li>
          </ul>
        </div>

        <div class="tray-foot">
          <router-link to="/skills" class="tray-link" @click="closeTray">打开完整技能库 ↗</router-link>
          <button type="button" class="tray-done" @click="closeTray">完成</button>
        </div>
      </aside>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import {
    skillsState, fetchSkills, trayOpen,
    isSelected, toggleSkill, removeSkill, moveSkill, selectedBriefs,
} from "../logic/skills";
import type { SkillBrief } from "../logic/skills";

const dragIndex = ref(-1);
const query = ref("");

// selectedBriefs() 随 selected / skillsState.all 变化重算
const chosen = computed<SkillBrief[]>(() => selectedBriefs());
const filteredSkills = computed(() => {
    const q = query.value.trim().toLocaleLowerCase();
    if (!q) return skillsState.all;
    return skillsState.all.filter((skill) => [
        skill.name, skill.id, skill.capability, skill.description, ...(skill.tags || []),
    ].some((value) => value?.toLocaleLowerCase().includes(q)));
});

function closeTray() { trayOpen.value = false; }
function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && trayOpen.value) closeTray();
}

function onDragStart(i: number) { dragIndex.value = i; }
function onDragOver(i: number) { /* 视觉占位，drop 时落位 */ void i; }
function onDrop(i: number) {
    if (dragIndex.value >= 0 && dragIndex.value !== i) moveSkill(dragIndex.value, i);
    dragIndex.value = -1;
}

onMounted(() => {
    fetchSkills();
    window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<style scoped>
.tray-scrim {
    position: fixed;
    inset: 0;
    z-index: 70;
    background: rgba(0, 0, 0, 0.62);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
}

.tray {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 71;
    width: min(580px, calc(100vw - 32px));
    max-height: min(680px, calc(100vh - 132px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transform: translate(-50%, -50%);
    background: rgba(4, 4, 2, 0.86);
    backdrop-filter: blur(30px) saturate(92%);
    -webkit-backdrop-filter: blur(30px) saturate(92%);
    border: 1px solid rgba(209, 200, 182, 0.2);
    border-top-color: rgba(244, 241, 236, 0.3);
    border-radius: 12px;
    box-shadow: inset 0 1px 0 rgba(244, 241, 236, 0.06), 0 28px 80px rgba(0, 0, 0, 0.62);
    color: #d1c8b6;
}

.tray-pop-enter-active,
.tray-pop-leave-active { transition: opacity 0.2s ease, transform 0.28s cubic-bezier(.2, 0, 0, 1); }
.tray-pop-enter-from,
.tray-pop-leave-to { opacity: 0; transform: translate(-50%, -48%) scale(0.975); }

.tray-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 17px 18px 15px;
    border-bottom: 1px solid rgba(209, 200, 182, 0.12);
    flex-shrink: 0;
}
.tray-title {
    font-family: "MinecrafterAlt", sans-serif;
    font-size: 16px;
    color: #d5c9ac;
}
.tray-summary { margin-top: 5px; font-size: 11px; color: rgba(209, 200, 182, 0.46); }
.tray-x {
    width: 30px;
    height: 30px;
    border: 1px solid rgba(209, 200, 182, 0.16);
    background: transparent;
    color: rgba(209, 200, 182, 0.6);
    font-size: 13px;
    cursor: pointer;
    border-radius: 4px;
}
.tray-x:hover { border-color: rgba(209, 200, 182, 0.42); color: #f4f1ec; }
.tray-x:focus-visible,
.tray-item:focus-visible,
.tray-move:focus-visible,
.tray-rm:focus-visible,
.tray-done:focus-visible,
.tray-error button:focus-visible { outline: 2px solid rgba(213, 201, 172, 0.7); outline-offset: 2px; }

.tray-section { padding: 13px 16px 4px; flex-shrink: 0; }
.chosen-section { max-height: 178px; overflow-y: auto; }
.tray-section.grow { flex: 1; min-height: 180px; overflow: auto; display: flex; flex-direction: column; padding-bottom: 14px; }
.tray-section-title {
    font-size: 11px;
    color: rgba(209, 200, 182, 0.52);
    letter-spacing: 0.04em;
    margin-bottom: 9px;
    display: flex;
    justify-content: space-between;
}
.tray-section-title span,
.tray-loading { color: rgba(198, 176, 125, 0.7); }
.tray-empty { font-size: 12px; color: rgba(209, 200, 182, 0.38); padding: 8px 2px 10px; }

.tray-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }

.tray-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 5px 7px 5px 9px;
    border-radius: 4px;
    background: rgba(209, 200, 182, 0.045);
    border: 1px solid rgba(209, 200, 182, 0.14);
    cursor: grab;
    font-size: 12px;
}
.tray-chip.dragging { opacity: 0.5; }
.tray-grip { color: rgba(209, 200, 182, 0.32); cursor: grab; }
.tray-order {
    width: 22px;
    flex-shrink: 0;
    color: #c6b07d;
    font-family: "Monaco", monospace;
    font-size: 10px;
}
.tray-chip-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tray-move,
.tray-rm {
    width: 24px;
    height: 24px;
    border: 0;
    background: transparent;
    color: rgba(209, 200, 182, 0.5);
    cursor: pointer;
    font-size: 11px;
    border-radius: 3px;
}
.tray-move:hover:not(:disabled) { background: rgba(209, 200, 182, 0.07); color: #f4f1ec; }
.tray-move:disabled { opacity: 0.18; cursor: default; }
.tray-rm:hover { background: rgba(179, 91, 82, 0.12); color: #df9a91; }

.tray-search-wrap {
    position: relative;
    display: flex;
    align-items: center;
    margin-bottom: 10px;
}
.tray-search-icon { position: absolute; left: 11px; color: rgba(209, 200, 182, 0.42); pointer-events: none; }
.tray-search {
    width: 100%;
    height: 34px;
    padding: 0 12px 0 32px;
    border: 1px solid rgba(209, 200, 182, 0.16);
    border-radius: 4px;
    outline: 0;
    background: rgba(0, 0, 0, 0.28);
    color: #f4f1ec;
    font: 12px/1 system-ui, "Noto Sans SC", sans-serif;
}
.tray-search::placeholder { color: rgba(209, 200, 182, 0.32); }
.tray-search:focus { border-color: rgba(198, 176, 125, 0.56); }
.tray-search::-webkit-search-cancel-button { filter: invert(0.75); }

.tray-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px;
    border: 1px solid rgba(179, 91, 82, 0.28);
    border-radius: 4px;
    color: #d7a29b;
    font-size: 11px;
}
.tray-error button { border: 0; background: transparent; color: #d5c9ac; cursor: pointer; }

.available-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.available-list > li { min-width: 0; }

.tray-item {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 10px;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    border: 1px solid rgba(209, 200, 182, 0.1);
    background: transparent;
    color: #d1c8b6;
    transition: background 0.15s, border-color 0.15s;
}
.tray-item:hover { background: rgba(209, 200, 182, 0.045); border-color: rgba(209, 200, 182, 0.22); }
.tray-item.on { background: rgba(198, 176, 125, 0.08); border-color: rgba(198, 176, 125, 0.46); }
.tray-check {
    width: 17px;
    height: 17px;
    flex-shrink: 0;
    margin-top: 1px;
    border-radius: 3px;
    border: 1px solid rgba(209, 200, 182, 0.28);
    color: #040402;
    font-size: 11px;
    text-align: center;
    line-height: 16px;
}
.tray-item.on .tray-check { border-color: #d5c9ac; background: #d5c9ac; }
.tray-item-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tray-item-name { font-size: 12px; font-weight: 600; color: #d1c8b6; }
.tray-item-cap {
    font-size: 10.5px; color: rgba(209, 200, 182, 0.46); line-height: 1.45;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}

.tray-foot {
    padding: 12px 16px;
    border-top: 1px solid rgba(209, 200, 182, 0.12);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
}
.tray-link { color: rgba(209, 200, 182, 0.62); font-size: 11px; text-decoration: none; }
.tray-link:hover { color: #d5c9ac; }
.tray-done {
    min-width: 72px;
    height: 30px;
    border: 1px solid #e1d8c4;
    border-bottom-color: #8f815f;
    border-radius: 4px;
    background: #d5c9ac;
    color: #040402;
    box-shadow: 0 2px 0 #5e5137, inset 0 1px 0 rgba(255, 255, 255, 0.3);
    cursor: pointer;
    font-size: 12px;
}
.tray-done:active { transform: translateY(1px); box-shadow: 0 1px 0 #5e5137; }

@media (max-width: 620px) {
    .tray { max-height: calc(100vh - 104px); }
    .available-list { grid-template-columns: 1fr; }
    .chosen-section { max-height: 150px; }
    .tray-head { padding-inline: 14px; }
    .tray-section, .tray-foot { padding-inline: 12px; }
}

@media (prefers-reduced-motion: reduce) {
    .tray-pop-enter-active,
    .tray-pop-leave-active { transition: opacity 0.15s linear; }
}
</style>

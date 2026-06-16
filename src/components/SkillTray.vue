<template>
  <div class="tray-root">
    <div v-if="trayOpen" class="tray-scrim" @click="trayOpen = false"></div>

    <transition name="tray-slide">
      <aside v-if="trayOpen" class="tray">
        <div class="tray-head">
          <span class="tray-title">技能手牌</span>
          <button class="tray-x" @click="trayOpen = false">✕</button>
        </div>

        <!-- 已选区（可拖拽排序） -->
        <div class="tray-section">
          <div class="tray-section-title">已选 · 拖动排序（靠前优先）</div>
          <div v-if="!chosen.length" class="tray-empty">尚未选择 skill</div>
          <ul v-else class="tray-list">
            <li v-for="(b, i) in chosen" :key="b.id"
                class="tray-chip" draggable="true"
                :class="{ dragging: dragIndex === i }"
                @dragstart="onDragStart(i)"
                @dragover.prevent="onDragOver(i)"
                @dragend="dragIndex = -1"
                @drop="onDrop(i)">
              <span class="tray-grip">⠿</span>
              <span class="tray-order">{{ i + 1 }}</span>
              <span class="tray-chip-name">{{ b.name || b.id }}</span>
              <button class="tray-rm" @click="removeSkill(b.id)" title="移出">✕</button>
            </li>
          </ul>
        </div>

        <!-- 全部 skill（勾选增减） -->
        <div class="tray-section grow">
          <div class="tray-section-title">
            全部 skill
            <span v-if="skillsState.loading" class="tray-loading">加载中…</span>
          </div>
          <div v-if="!skillsState.loading && skillsState.all.length === 0" class="tray-empty">
            仓库暂无 skill
          </div>
          <ul class="tray-list">
            <li v-for="b in skillsState.all" :key="b.id"
                class="tray-item" :class="{ on: isSelected(b.id) }"
                @click="toggleSkill(b.id)">
              <span class="tray-check">{{ isSelected(b.id) ? '✓' : '' }}</span>
              <span class="tray-item-body">
                <span class="tray-item-name">{{ b.name || b.id }}</span>
                <span class="tray-item-cap">{{ b.capability || b.description || '' }}</span>
              </span>
            </li>
          </ul>
        </div>

        <div class="tray-foot">
          <router-link to="/skills" class="tray-link" @click="trayOpen = false">前往技能库浏览 →</router-link>
        </div>
      </aside>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import {
    skillsState, fetchSkills, trayOpen,
    isSelected, toggleSkill, removeSkill, moveSkill, selectedBriefs,
} from "../logic/skills";
import type { SkillBrief } from "../logic/skills";

const dragIndex = ref(-1);

// selectedBriefs() 随 selected / skillsState.all 变化重算
const chosen = computed<SkillBrief[]>(() => selectedBriefs());

function onDragStart(i: number) { dragIndex.value = i; }
function onDragOver(i: number) { /* 视觉占位，drop 时落位 */ void i; }
function onDrop(i: number) {
    if (dragIndex.value >= 0 && dragIndex.value !== i) moveSkill(dragIndex.value, i);
    dragIndex.value = -1;
}

onMounted(() => { fetchSkills(); });
</script>

<style scoped>
.tray-fab {
    position: fixed;
    left: 22px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 40;
    width: 46px;
    height: 46px;
    border-radius: 14px;
    border: 1px solid rgba(245, 222, 179, 0.28);
    background: rgba(28, 24, 18, 0.78);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: wheat;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    transition: transform 0.15s, border-color 0.2s, background 0.2s;
}
.tray-fab:hover { border-color: wheat; transform: translateY(-50%) scale(1.05); }
.tray-fab.on { background: rgba(245, 222, 179, 0.16); border-color: wheat; }
.tray-badge {
    position: absolute;
    top: -6px;
    right: -6px;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: wheat;
    color: #1c1812;
    font-size: 11px;
    font-weight: 700;
    line-height: 18px;
    text-align: center;
}

.tray-scrim {
    position: fixed;
    inset: 0;
    z-index: 41;
    background: rgba(0, 0, 0, 0.25);
}

.tray {
    position: fixed;
    left: 0;
    top: 80px;
    bottom: 0;
    z-index: 42;
    width: min(320px, 86vw);
    display: flex;
    flex-direction: column;
    background: rgba(20, 17, 12, 0.94);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-right: 1px solid rgba(245, 222, 179, 0.14);
    box-shadow: 8px 0 40px rgba(0, 0, 0, 0.5);
    color: #f3e7d4;
}

.tray-slide-enter-active, .tray-slide-leave-active { transition: transform 0.25s ease; }
.tray-slide-enter-from, .tray-slide-leave-to { transform: translateX(-100%); }

.tray-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px;
    border-bottom: 1px solid rgba(245, 222, 179, 0.1);
    flex-shrink: 0;
}
.tray-title { font-family: "ZhuoKai", sans-serif; font-size: 17px; color: wheat; }
.tray-x {
    border: none; background: transparent; color: rgba(255, 245, 235, 0.6);
    font-size: 15px; cursor: pointer; padding: 4px 8px; border-radius: 8px;
}
.tray-x:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }

.tray-section { padding: 14px 16px 6px; flex-shrink: 0; }
.tray-section.grow { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
.tray-section-title {
    font-size: 12px;
    color: rgba(255, 245, 235, 0.5);
    letter-spacing: 0.03em;
    margin-bottom: 8px;
    display: flex;
    justify-content: space-between;
}
.tray-loading { color: rgba(245, 222, 179, 0.6); }
.tray-empty { font-size: 12px; color: rgba(255, 245, 235, 0.35); padding: 6px 2px; }

.tray-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }

.tray-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(245, 222, 179, 0.1);
    border: 1px solid rgba(245, 222, 179, 0.16);
    cursor: grab;
    font-size: 13px;
}
.tray-chip.dragging { opacity: 0.5; }
.tray-grip { color: rgba(255, 245, 235, 0.4); cursor: grab; }
.tray-order {
    width: 18px; height: 18px; flex-shrink: 0;
    border-radius: 6px; background: wheat; color: #1c1812;
    font-size: 11px; font-weight: 700; text-align: center; line-height: 18px;
}
.tray-chip-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tray-rm {
    border: none; background: transparent; color: rgba(255, 245, 235, 0.5);
    cursor: pointer; font-size: 12px; padding: 2px 4px; border-radius: 6px;
}
.tray-rm:hover { background: rgba(255, 80, 80, 0.2); color: #ff9a8a; }

.tray-item {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 9px 10px;
    border-radius: 10px;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background 0.15s, border-color 0.15s;
}
.tray-item:hover { background: rgba(255, 255, 255, 0.05); }
.tray-item.on { background: rgba(143, 209, 106, 0.1); border-color: rgba(143, 209, 106, 0.3); }
.tray-check {
    width: 18px; height: 18px; flex-shrink: 0; margin-top: 1px;
    border-radius: 6px; border: 1px solid rgba(245, 222, 179, 0.35);
    color: #8fd16a; font-size: 12px; text-align: center; line-height: 17px;
}
.tray-item.on .tray-check { border-color: #8fd16a; }
.tray-item-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tray-item-name { font-size: 13px; font-weight: 600; }
.tray-item-cap {
    font-size: 11px; color: rgba(255, 245, 235, 0.5); line-height: 1.4;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}

.tray-foot { padding: 14px 16px; border-top: 1px solid rgba(245, 222, 179, 0.1); flex-shrink: 0; }
.tray-link { color: #ffd98a; font-size: 13px; text-decoration: none; }
.tray-link:hover { text-decoration: underline; }
</style>

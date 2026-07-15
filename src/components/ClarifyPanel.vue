<template>
  <div class="clarify-wrap glass2">
    <div class="clarify-header">
      <span class="clarify-progress">
        {{ safeIndex + 1 }} / {{ genTask.clarifyTodos.length }}
      </span>
      <span class="clarify-round">澄清第 {{ genTask.clarifyRound }} 轮</span>
      <div class="clarify-nav">
        <span class="nav-arrow" :class="{ disabled: safeIndex === 0 }" @click="prev">‹</span>
        <span class="nav-arrow"
              :class="{ disabled: safeIndex >= genTask.clarifyTodos.length - 1 }"
              @click="next">›</span>
      </div>
    </div>

    <div v-if="current" class="clarify-card">
      <div class="clarify-q">{{ current.question }}</div>

      <div class="clarify-options">
        <div v-for="opt in current.options" :key="opt" class="clarify-opt-wrap">
          <span class="option-pill"
                :class="{ active: isSelected(current, opt) }"
                @click="toggle(current, opt)">
            {{ opt }}
          </span>
          <CurveChart v-if="current.chart === 'multi'"
                      :type="(opt as any)"
                      class="clarify-chart"/>
        </div>

        <span v-if="current.allowCustom"
              class="option-pill"
              :class="{ active: isCustomActive(current) }"
              @click="activateCustom(current)">
          其他…
        </span>
      </div>

      <input v-if="customActive[current.id] !== undefined"
             v-model="customActive[current.id]"
             class="clarify-custom"
             placeholder="在此输入你的其他想法（回车进入下一题）"
             @input="onCustomInput(current)"
             @keydown.enter.prevent="onCustomEnter(current)"/>
    </div>

    <div class="clarify-footer">
      <span class="answered-count">
        已完成 {{ answeredCount }} / {{ genTask.clarifyTodos.length }}
      </span>
      <button class="floor-btn" :disabled="!allAnswered" @click="confirm">
        确认并进入下一步
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, computed, ref, watch } from "vue";
import { genTask, submitClarifyAnswers } from "../logic/generateState";
import type { TodoItem } from "../logic/generateState";
import CurveChart from "./CurveChart.vue";

const selections = reactive<Record<string, string | string[]>>({});
const customActive = reactive<Record<string, string>>({});
const currentIndex = ref(0);

const safeIndex = computed(() => {
    const len = genTask.clarifyTodos.length;
    if (len === 0) return 0;
    return Math.min(currentIndex.value, len - 1);
});
const current = computed(() => genTask.clarifyTodos[safeIndex.value] || null);

watch(() => genTask.clarifyTodos.length, (n, old) => {
    if (old === 0 && n > 0) currentIndex.value = 0;
});

function prev() {
    if (currentIndex.value > 0) currentIndex.value--;
}
function next() {
    if (currentIndex.value < genTask.clarifyTodos.length - 1) currentIndex.value++;
}

function isSelected(todo: TodoItem, opt: string): boolean {
    const v = selections[todo.id];
    if (todo.multiSelect) return Array.isArray(v) && v.includes(opt);
    return v === opt;
}

function isCustomActive(todo: TodoItem): boolean {
    return customActive[todo.id] !== undefined;
}

function toggle(todo: TodoItem, opt: string) {
    delete customActive[todo.id];
    if (todo.multiSelect) {
        const arr = Array.isArray(selections[todo.id]) ? [...(selections[todo.id] as string[])] : [];
        const idx = arr.indexOf(opt);
        if (idx >= 0) arr.splice(idx, 1); else arr.push(opt);
        selections[todo.id] = arr;
    } else {
        selections[todo.id] = opt;
        if (currentIndex.value < genTask.clarifyTodos.length - 1) {
            currentIndex.value++;
        }
    }
}

function activateCustom(todo: TodoItem) {
    if (customActive[todo.id] !== undefined) {
        delete customActive[todo.id];
        delete selections[todo.id];
        return;
    }
    customActive[todo.id] = "";
    if (todo.multiSelect) selections[todo.id] = [];
    else delete selections[todo.id];
}

function onCustomInput(todo: TodoItem) {
    const v = customActive[todo.id];
    if (todo.multiSelect) selections[todo.id] = v ? [v] : [];
    else selections[todo.id] = v;
}

function onCustomEnter(todo: TodoItem) {
    onCustomInput(todo);
    if (!isAnswered(todo)) return;
    if (currentIndex.value < genTask.clarifyTodos.length - 1) {
        currentIndex.value++;
    }
}

function isAnswered(t: TodoItem): boolean {
    const v = selections[t.id];
    if (t.multiSelect) return Array.isArray(v) && v.length > 0;
    return typeof v === "string" && v.length > 0;
}

const answeredCount = computed(() =>
    genTask.clarifyTodos.filter(t => isAnswered(t)).length,
);

const allAnswered = computed(() =>
    genTask.clarifyTodos.length > 0 && genTask.clarifyTodos.every(isAnswered),
);

function confirm() {
    if (!allAnswered.value) return;
    const snapshot: Record<string, string | string[]> = {};
    for (const t of genTask.clarifyTodos) snapshot[t.id] = selections[t.id];
    for (const k of Object.keys(selections)) delete selections[k];
    for (const k of Object.keys(customActive)) delete customActive[k];
    currentIndex.value = 0;
    submitClarifyAnswers(snapshot);
}
</script>

<style scoped>
.clarify-wrap {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px;
    font-family: "Jiangxizhuokai", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.clarify-header {
    display: flex;
    align-items: center;
    gap: 12px;
    color: rgba(255, 255, 255, 0.55);
    font-size: 12px;
}
.clarify-progress {
    padding: 4px 10px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.08);
    color: wheat;
    font-size: 12px;
    letter-spacing: 0.5px;
}
.clarify-round {
    flex: 1;
}
.clarify-nav {
    display: flex;
    gap: 8px;
}
.nav-arrow {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.75);
    font-size: 16px;
    cursor: pointer;
    user-select: none;
    transition: all 0.15s;
}
.nav-arrow:hover:not(.disabled) {
    border-color: wheat;
    color: wheat;
}
.nav-arrow.disabled {
    opacity: 0.25;
    cursor: not-allowed;
}
.clarify-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.02);
    animation: fadeSlide 0.25s ease-out;
}
@keyframes fadeSlide {
    from { opacity: 0; transform: translateX(8px); }
    to   { opacity: 1; transform: translateX(0); }
}
.clarify-q {
    color: rgba(255, 255, 255, 0.9);
    font-size: 15px;
    line-height: 1.5;
}
.clarify-options {
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: flex-start;
}
.clarify-opt-wrap {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-start;
}
.clarify-chart {
    margin-top: 2px;
}
.option-pill {
    min-width: 120px;
    padding: 10px 18px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.78);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
    line-height: 1.3;
    text-align: left;
}
.option-pill.active {
    background: wheat;
    color: #000;
    border-color: wheat;
}
.option-pill:hover {
    border-color: rgba(255, 255, 255, 0.4);
}
.clarify-custom {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    padding: 8px 12px;
    color: #fff;
    font-size: 13px;
    outline: none;
    width: 100%;
    max-width: 360px;
}
.clarify-custom:focus {
    border-color: wheat;
}
.clarify-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
}
.answered-count {
    color: rgba(255, 255, 255, 0.45);
    font-size: 12px;
}
.floor-btn {
    padding: 8px 24px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.05);
    color: wheat;
    font-size: 14px;
    cursor: pointer;
}
.floor-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
}
</style>

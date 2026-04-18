<template>
  <div class="clarify-wrap glass2">
    <div class="clarify-header">
      <span class="clarify-round">澄清第 {{ genTask.clarifyRound }} 轮</span>
      <span class="clarify-sub">{{ genTask.clarifyTodos.length }} 项待确认</span>
    </div>

    <div v-for="todo in genTask.clarifyTodos" :key="todo.id" class="clarify-card">
      <div class="clarify-q">{{ todo.question }}</div>

      <div class="clarify-options">
        <div v-for="opt in todo.options" :key="opt" class="clarify-opt-wrap">
          <span class="select-chip"
                :class="{ active: isSelected(todo, opt) }"
                @click="toggle(todo, opt)">
            {{ opt }}
          </span>
          <CurveChart v-if="todo.chart === 'multi'"
                      :type="(opt as any)"
                      class="clarify-chart"/>
        </div>

        <span v-if="todo.allowCustom"
              class="select-chip"
              :class="{ active: isCustomActive(todo) }"
              @click="activateCustom(todo)">
          其他…
        </span>
      </div>

      <input v-if="customActive[todo.id] !== undefined"
             v-model="customActive[todo.id]"
             class="clarify-custom"
             placeholder="在此输入你的其他想法"
             @input="onCustomInput(todo)"/>
    </div>

    <button class="floor-btn" :disabled="!allAnswered" @click="confirm">
      确认并进入下一步
    </button>
  </div>
</template>

<script setup lang="ts">
import { reactive, computed } from "vue";
import { genTask, submitClarifyAnswers } from "../logic/generateState";
import type { TodoItem } from "../logic/generateState";
import CurveChart from "./CurveChart.vue";

// 每个 todo.id → 选中值（单选为 string，多选为 string[]）
const selections = reactive<Record<string, string | string[]>>({});
// 每个 todo.id → 自定义文本（存在即视为"其他"被激活）
const customActive = reactive<Record<string, string>>({});

function isSelected(todo: TodoItem, opt: string): boolean {
    const v = selections[todo.id];
    if (todo.multiSelect) return Array.isArray(v) && v.includes(opt);
    return v === opt;
}

function isCustomActive(todo: TodoItem): boolean {
    return customActive[todo.id] !== undefined;
}

function toggle(todo: TodoItem, opt: string) {
    // 点选预设项时清除自定义态
    delete customActive[todo.id];
    if (todo.multiSelect) {
        const arr = Array.isArray(selections[todo.id]) ? [...(selections[todo.id] as string[])] : [];
        const idx = arr.indexOf(opt);
        if (idx >= 0) arr.splice(idx, 1); else arr.push(opt);
        selections[todo.id] = arr;
    } else {
        selections[todo.id] = opt;
    }
}

function activateCustom(todo: TodoItem) {
    if (customActive[todo.id] !== undefined) {
        delete customActive[todo.id];
        delete selections[todo.id];
        return;
    }
    customActive[todo.id] = "";
    // 激活自定义时清空预设选择
    if (todo.multiSelect) selections[todo.id] = [];
    else delete selections[todo.id];
}

function onCustomInput(todo: TodoItem) {
    const v = customActive[todo.id];
    if (todo.multiSelect) selections[todo.id] = v ? [v] : [];
    else selections[todo.id] = v;
}

const allAnswered = computed(() => {
    return genTask.clarifyTodos.every(t => {
        const v = selections[t.id];
        if (t.multiSelect) return Array.isArray(v) && v.length > 0;
        return typeof v === "string" && v.length > 0;
    });
});

function confirm() {
    if (!allAnswered.value) return;
    const snapshot: Record<string, string | string[]> = {};
    for (const t of genTask.clarifyTodos) snapshot[t.id] = selections[t.id];
    // 清理本地态以便下一轮复用
    for (const k of Object.keys(selections)) delete selections[k];
    for (const k of Object.keys(customActive)) delete customActive[k];
    submitClarifyAnswers(snapshot);
}
</script>

<style scoped>
.clarify-wrap {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px;
}
.clarify-header {
    display: flex;
    justify-content: space-between;
    color: rgba(255, 255, 255, 0.5);
    font-size: 12px;
}
.clarify-round {
    color: wheat;
}
.clarify-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.02);
}
.clarify-q {
    color: rgba(255, 255, 255, 0.85);
    font-size: 14px;
}
.clarify-options {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
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
.select-chip {
    padding: 4px 14px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.7);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
}
.select-chip.active {
    background: wheat;
    color: #000;
    border-color: wheat;
}
.select-chip:hover {
    border-color: rgba(255, 255, 255, 0.4);
}
.clarify-custom {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    padding: 6px 10px;
    color: #fff;
    font-size: 13px;
    outline: none;
}
.clarify-custom:focus {
    border-color: wheat;
}
.floor-btn {
    margin-top: 4px;
    padding: 8px 24px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.05);
    color: wheat;
    font-size: 14px;
    cursor: pointer;
    align-self: flex-start;
}
.floor-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
}
</style>

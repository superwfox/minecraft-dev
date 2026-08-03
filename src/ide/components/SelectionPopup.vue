<template>
  <div v-if="visible" class="sel-popup" :style="positionStyle" @mousedown.stop @click.stop>
    <div class="sel-header">
      <span class="sel-title">
        <span class="spark">✦</span>
        <span>AI · 选区</span>
        <span class="sel-snip">{{ snippetPreview }}</span>
      </span>
      <span class="sel-close" @click="$emit('close')">×</span>
    </div>

    <!-- 空闲：功能词条 + 自定义输入 -->
    <div v-if="phase === 'idle'" class="sel-body">
      <div class="sel-actions">
        <button v-for="a in actions" :key="a.label" class="sel-action" @click="runTask(a.label, a.task)">
          <span class="sel-action-icon">{{ a.icon }}</span>
          <span class="sel-action-label">{{ a.label }}</span>
        </button>
      </div>
      <div class="sel-input-row">
        <input ref="inputRef" v-model="customInput" class="sel-input"
               placeholder="或自定义提问..."
               @compositionstart="onImeCompositionStart"
               @compositionend="onImeCompositionEnd"
               @keydown.enter="onCustomEnter"/>
        <button class="sel-send" :disabled="!customInput.trim()" @click="onCustomAsk">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
            <path d="m1.5 1.5 13 6.5-13 6.5 2.5-6.5-2.5-6.5Z"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- 流式中 -->
    <div v-else-if="phase === 'thinking'" class="sel-body">
      <div class="sel-task-tag">{{ currentTask }}</div>
      <div class="sel-stream" :class="{ 'waiting-text': !streamingText }">{{ streamingText || 'thinking…' }}<span class="sel-cursor">▌</span></div>
    </div>

    <!-- 已应用（修改类任务） -->
    <div v-else-if="phase === 'applied'" class="sel-body">
      <div class="sel-applied-row">
        <span class="sel-applied-tick">✓</span>
        <span class="sel-applied-text">已应用 · {{ currentTask }}</span>
      </div>
      <div class="sel-result preview">{{ extractedCode }}</div>
      <div class="sel-secondary-row">
        <button class="sel-secondary" @click="onUndo">撤销 ⌘Z</button>
        <button class="sel-secondary" @click="$emit('close')">关闭</button>
        <button class="sel-secondary primary" @click="onPushToDockApplied">进入主聊天 ↗</button>
      </div>
    </div>

    <!-- 解释类结果 -->
    <div v-else class="sel-body">
      <div class="sel-task-tag">{{ currentTask }}</div>
      <div class="sel-result">{{ result }}</div>
      <div class="sel-secondary-row">
        <button class="sel-secondary" @click="phase = 'idle'">重新提问</button>
        <button class="sel-secondary primary" @click="onPushToDock">进入主聊天 ↗</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {ref, computed, watch, nextTick} from "vue";
import {useIDEChat} from "../composables/useIDEChat";
import {isImeComposing, onImeCompositionEnd, onImeCompositionStart} from "../../logic/keyboard";

const props = defineProps<{
    visible: boolean;
    snippet: string;
    contextPath: string;
    position: { left: number; top: number };
    maxHeight: number;
}>();

const emit = defineEmits<{
    (e: "close"): void;
    (e: "apply", code: string): void;
    (e: "undo"): void;
}>();

const phase = ref<"idle" | "thinking" | "result" | "applied">("idle");
const streamingText = ref("");
const result = ref("");
const extractedCode = ref("");
const customInput = ref("");
const currentTask = ref("");
const inputRef = ref<HTMLInputElement | null>(null);

const actions = [
    {icon: "📖", label: "解释", task: "解释这段代码的作用、关键点、潜在副作用"},
    {icon: "✨", label: "重构", task: "对这段代码做合理重构（更好的命名、抽出方法、消除重复），保持行为不变"},
    {icon: "🩹", label: "修 Bug", task: "找出可能的 Bug 或边界问题，并给出修复后的版本"},
    {icon: "⚡", label: "优化", task: "在不改变功能的前提下，对性能和可读性进行优化"},
    {icon: "💬", label: "加注释", task: "为关键逻辑添加清晰、简明的中文注释（行内或方法级），不要冗余"},
];

const snippetPreview = computed(() => {
    const t = props.snippet.replace(/\s+/g, " ").trim();
    return t.length > 40 ? t.slice(0, 40) + "…" : t;
});

const positionStyle = computed(() => ({
    left: props.position.left + "px",
    top: props.position.top + "px",
    maxHeight: props.maxHeight + "px",
}));

function extractCode(raw: string): string | null {
    const m = raw.match(/```[\w-]*[ \t]*\n?([\s\S]*?)\n?```/);
    if (!m) return null;
    const code = m[1].replace(/^\n+|\n+$/g, "");
    return code.length > 0 ? code : null;
}

async function runTask(label: string, task: string) {
    if (phase.value === "thinking") return;
    currentTask.value = label;
    phase.value = "thinking";
    streamingText.value = "";
    result.value = "";
    extractedCode.value = "";
    const chat = useIDEChat();
    try {
        const full = await chat.askWithSelection({
            snippet: props.snippet,
            contextPath: props.contextPath,
            taskHint: task,
            onDelta: (c) => { streamingText.value += c; },
        });
        const code = extractCode(full);
        if (code) {
            extractedCode.value = code;
            result.value = full;
            emit("apply", code);
            phase.value = "applied";
        } else {
            result.value = full;
            phase.value = "result";
        }
    } catch (e: any) {
        result.value = `调用失败：${e?.message || String(e)}`;
        phase.value = "result";
    }
}

function onCustomEnter(event: KeyboardEvent) {
    if (isImeComposing(event)) return;
    event.preventDefault();
    onCustomAsk();
}

function onCustomAsk() {
    const q = customInput.value.trim();
    if (!q) return;
    customInput.value = "";
    runTask(q.length > 14 ? q.slice(0, 12) + "…" : q, q);
}

function onPushToDock() {
    const chat = useIDEChat();
    chat.pushSelectionToDock({
        snippet: props.snippet,
        contextPath: props.contextPath,
        question: currentTask.value,
        reply: result.value,
    });
    emit("close");
}

function onPushToDockApplied() {
    const chat = useIDEChat();
    chat.pushSelectionToDock({
        snippet: props.snippet,
        contextPath: props.contextPath,
        question: currentTask.value + "（已应用）",
        reply: `已自动修改选区为：\n\n\`\`\`\n${extractedCode.value}\n\`\`\``,
    });
    emit("close");
}

function onUndo() {
    emit("undo");
    emit("close");
}

// 选区变化时重置面板状态
watch(() => props.snippet, () => {
    phase.value = "idle";
    streamingText.value = "";
    result.value = "";
    extractedCode.value = "";
    customInput.value = "";
});

watch(() => props.visible, async (v) => {
    if (v && phase.value === "idle") {
        await nextTick();
        // 不自动 focus 避免抢光标，但点击输入框可立即用
    }
});
</script>

<style scoped>
.sel-popup {
  position: absolute;
  width: 380px;
  z-index: 50;
  background: rgba(18, 18, 22, 0.96);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(245,222,179,0.25);
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(245,222,179,0.05);
  overflow: hidden;
  animation: popIn 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
  color: rgba(255,255,255,0.88);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
@keyframes popIn {
  from { opacity: 0; transform: translateY(-4px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.sel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  font-size: 11px;
  flex-shrink: 0;
}
.sel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: wheat;
  letter-spacing: 0.5px;
  flex: 1;
  min-width: 0;
}
.spark {
  color: wheat;
  font-size: 11px;
  filter: drop-shadow(0 0 4px rgba(245,222,179,0.5));
}
.sel-snip {
  color: rgba(255,255,255,0.4);
  font-family: "Monaco", monospace;
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-left: 6px;
  flex: 1;
  min-width: 0;
}
.sel-close {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: rgba(255,255,255,0.5);
  cursor: pointer;
  font-size: 16px;
  transition: all 0.15s;
  flex-shrink: 0;
}
.sel-close:hover { background: rgba(255,255,255,0.1); color: wheat; }

.sel-body {
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: 8px;
}

.sel-actions {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
  flex-shrink: 0;
}
.sel-action {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px;
  color: rgba(255,255,255,0.75);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}
.sel-action:hover {
  background: rgba(245,222,179,0.08);
  border-color: rgba(245,222,179,0.3);
  color: wheat;
}
.sel-action-icon { font-size: 16px; }

.sel-input-row {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-shrink: 0;
  margin-top: auto;
}
.sel-input {
  flex: 1;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 6px;
  padding: 6px 10px;
  color: rgba(255,255,255,0.9);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s;
}
.sel-input:focus { border-color: rgba(245,222,179,0.35); }
.sel-input::placeholder { color: rgba(255,255,255,0.3); }
.sel-send {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: wheat;
  color: #0d0d0f;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.sel-send:hover:not(:disabled) { background: #ffe9b5; }
.sel-send:disabled { opacity: 0.3; cursor: not-allowed; }

.sel-task-tag {
  align-self: flex-start;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(245,222,179,0.15);
  color: wheat;
  text-transform: uppercase;
  letter-spacing: 1px;
  flex-shrink: 0;
}
.sel-stream, .sel-result {
  font-size: 12px;
  line-height: 1.65;
  color: rgba(255,255,255,0.88);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  white-space: pre-wrap;
  font-family: "Monaco", system-ui, sans-serif;
}
.sel-stream.waiting-text {
  font-family: "MinecrafterReg", "Monaco", monospace;
  letter-spacing: 1px;
}
.sel-result.preview {
  font-family: "Monaco", monospace;
  font-size: 11px;
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(105,214,160,0.15);
  border-radius: 6px;
  padding: 8px 10px;
  color: rgba(255,255,255,0.75);
}

.sel-applied-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  font-size: 12px;
  color: #69d6a0;
}
.sel-applied-tick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(105,214,160,0.18);
  color: #69d6a0;
  font-weight: bold;
  flex-shrink: 0;
}
.sel-applied-text {
  font-weight: 500;
  letter-spacing: 0.3px;
}
.sel-cursor {
  color: wheat;
  margin-left: 2px;
  animation: blink 1s steps(2) infinite;
}
@keyframes blink { to { visibility: hidden; } }

.sel-secondary-row {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.sel-secondary {
  flex: 1;
  padding: 6px 10px;
  font-size: 11px;
  border-radius: 6px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.75);
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.sel-secondary:hover {
  background: rgba(255,255,255,0.08);
  border-color: rgba(255,255,255,0.2);
  color: wheat;
}
.sel-secondary.primary {
  background: rgba(245,222,179,0.15);
  border-color: rgba(245,222,179,0.35);
  color: wheat;
}
.sel-secondary.primary:hover {
  background: rgba(245,222,179,0.25);
  border-color: rgba(245,222,179,0.5);
}
</style>

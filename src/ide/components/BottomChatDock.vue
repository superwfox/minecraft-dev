<template>
  <div class="dock" :class="`state-${state}`" @click="onDockClick">
    <!-- 收缩态：左下胶囊圆角矩形 -->
    <div class="layer layer-dormant">
      <span class="sparkle">✦</span>
      <span class="dormant-label">AI 助手</span>
      <span class="dormant-hint">下滑唤起 / 点击</span>
    </div>

    <!-- 悬浮态：全宽提示 -->
    <div class="layer layer-hint">
      <span class="sparkle big">✦</span>
      <span class="hint-text">想做些什么？</span>
      <span class="hint-shortcut">点击开始 · Esc 收回</span>
    </div>

    <!-- 展开态：消息 + 输入 -->
    <div class="layer layer-open" @click.stop>
      <div class="open-header">
        <span class="open-title">
          <span class="sparkle">✦</span> AI 助手
        </span>
        <span v-if="contextHint" class="open-context">{{ contextHint }}</span>
        <span class="open-flex"></span>
        <span class="open-close" @click="$emit('close')" title="收起 (Esc)">×</span>
      </div>

      <div class="open-body" ref="bodyRef">
        <div v-if="!messages.length && !streaming" class="open-empty">
          <div class="empty-row">告诉 AI 你想 <em>创建</em> / <em>修改</em> 哪个文件，或问任何关于代码的问题</div>
          <div class="quick-tags">
            <span v-for="q in quickPrompts" :key="q" class="quick-tag" @click="$emit('send', q)">{{ q }}</span>
          </div>
        </div>
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="`msg-${m.role}`">
          <div v-if="m.role === 'assistant'" class="msg-meta">
            <span v-if="m.intent" class="msg-intent" :class="`intent-${m.intent}`">{{ intentLabels[m.intent] || m.intent }}</span>
            <span v-if="m.files?.length" class="msg-file-count">{{ m.files.length }} 个文件</span>
          </div>
          <div v-if="m.text" class="msg-text">{{ m.text }}</div>
          <div v-if="m.files?.length" class="msg-files">
            <div v-for="(f, j) in m.files" :key="j" class="msg-file" @click="$emit('openFile', f.path)">
              <span class="msg-file-action" :class="f.action">{{ f.action === 'create' ? '+' : '✎' }}</span>
              <span class="msg-file-path">{{ f.path }}</span>
            </div>
          </div>
        </div>
        <div v-if="streaming" class="msg msg-assistant">
          <div class="msg-text streaming" :class="{ 'waiting-text': !streamingText }">{{ streamingText || 'thinking…' }}</div>
        </div>
      </div>

      <div class="open-input-row">
        <textarea ref="inputRef" v-model="input" class="open-input"
                  :placeholder="streaming ? '生成中...' : '描述你想做的（创建 / 修改 / 询问），Shift+Enter 换行'"
                  :disabled="streaming"
                  @keydown.enter.exact.prevent="send"
                  rows="1"/>
        <button class="open-send" :disabled="!input.trim() || streaming" @click="send">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="m1.5 1.5 13 6.5-13 6.5 2.5-6.5-2.5-6.5Z"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {ref, watch, nextTick} from "vue";

export type ChatFileAction = { path: string; action: "create" | "edit"; content: string };
export type ChatMessage = {
    role: "user" | "assistant" | "system";
    text: string;
    intent?: "chat" | "create" | "edit";
    files?: ChatFileAction[];
};

const props = defineProps<{
    state: "dormant" | "hint" | "open";
    messages: ChatMessage[];
    streaming: boolean;
    streamingText: string;
    contextHint?: string;
}>();

const emit = defineEmits<{
    (e: "send", text: string): void;
    (e: "openFile", path: string): void;
    (e: "requestOpen"): void;
    (e: "close"): void;
}>();

const input = ref("");
const bodyRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLTextAreaElement | null>(null);

const intentLabels: Record<string, string> = {
    chat: "答疑",
    create: "创建文件",
    edit: "修改文件",
};

const quickPrompts = [
    "解释当前文件的作用",
    "新建一个 Listener 处理玩家死亡",
    "把当前文件改成支持配置开关",
    "整体代码有哪些可以改进的？",
];

function onDockClick() {
    if (props.state !== "open") emit("requestOpen");
}

function send() {
    const t = input.value.trim();
    if (!t || props.streaming) return;
    input.value = "";
    emit("send", t);
}

watch(() => props.state, async (v) => {
    if (v === "open") {
        await nextTick();
        setTimeout(() => inputRef.value?.focus(), 240);
    }
});

watch(() => [props.messages.length, props.streamingText], async () => {
    await nextTick();
    if (bodyRef.value) bodyRef.value.scrollTop = bodyRef.value.scrollHeight;
});
</script>

<style scoped>
.dock {
  position: absolute;
  bottom: 12px;
  right: auto;
  background: rgba(20, 20, 24, 0.92);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(245,222,179,0.22);
  box-shadow: 0 -10px 30px rgba(0,0,0,0.35), 0 0 0 1px rgba(245,222,179,0.04);
  overflow: hidden;
  cursor: pointer;
  z-index: 25;
  will-change: width, height, left, border-radius;
  /* 默认（即"扩展"方向）：几何立刻变化，内容延迟淡入 */
  transition:
      left 0.42s cubic-bezier(0.32, 0.72, 0.24, 1),
      width 0.42s cubic-bezier(0.32, 0.72, 0.24, 1),
      height 0.42s cubic-bezier(0.32, 0.72, 0.24, 1),
      border-radius 0.42s cubic-bezier(0.32, 0.72, 0.24, 1),
      box-shadow 0.3s ease,
      border-color 0.3s ease;
}

/* DORMANT — 左下大胶囊。"收缩"方向：几何 transition 整体加 0.22s 延迟，
   让内容层先淡出再开始变形，杜绝缩小过程中的文本重排闪烁 */
.dock.state-dormant {
  left: 20px;
  width: 280px;
  height: 42px;
  border-radius: 21px;
  transition:
      left 0.42s cubic-bezier(0.32, 0.72, 0.24, 1) 0.22s,
      width 0.42s cubic-bezier(0.32, 0.72, 0.24, 1) 0.22s,
      height 0.42s cubic-bezier(0.32, 0.72, 0.24, 1) 0.22s,
      border-radius 0.42s cubic-bezier(0.32, 0.72, 0.24, 1) 0.22s,
      box-shadow 0.3s ease,
      border-color 0.3s ease;
}
.dock.state-dormant:hover {
  border-color: rgba(245,222,179,0.4);
  box-shadow: 0 -10px 30px rgba(0,0,0,0.35), 0 0 0 1px rgba(245,222,179,0.15), 0 0 22px rgba(245,222,179,0.18);
}

/* HINT — 全宽提示条 */
.dock.state-hint {
  left: 14px;
  width: calc(100% - 28px);
  height: 56px;
  border-radius: 16px;
  border-color: rgba(245,222,179,0.32);
  cursor: pointer;
}

/* OPEN — 全宽向上展开 */
.dock.state-open {
  left: 14px;
  width: calc(100% - 28px);
  height: 60vh;
  max-height: 640px;
  border-radius: 16px;
  cursor: default;
  border-color: rgba(245,222,179,0.22);
}

/* 层叠的内容层。
   离开当前状态：用 base 规则（无延迟，立即开始淡出）
   进入新状态：扩展时延迟 0.18s 等几何先到位；收缩时延迟 0.40s 等几何 settle 完 */
.layer {
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
  display: flex;
  transition: opacity 0.18s ease;
}
.dock.state-hint .layer-hint,
.dock.state-open .layer-open {
  opacity: 1;
  pointer-events: auto;
  transition: opacity 0.24s ease 0.18s;
}
.dock.state-dormant .layer-dormant {
  opacity: 1;
  pointer-events: auto;
  transition: opacity 0.24s ease 0.40s;
}

/* dormant 层 */
.layer-dormant {
  align-items: center;
  padding: 0 18px;
  gap: 10px;
}
.sparkle {
  color: wheat;
  font-size: 13px;
  filter: drop-shadow(0 0 6px rgba(245,222,179,0.6));
  animation: spark 3s ease-in-out infinite;
}
.sparkle.big { font-size: 18px; }
@keyframes spark {
  0%, 100% { opacity: 1; transform: scale(1) rotate(0deg); }
  50% { opacity: 0.55; transform: scale(0.92) rotate(45deg); }
}
.dormant-label {
  font-size: 13px;
  color: rgba(255,255,255,0.85);
  font-weight: 500;
  letter-spacing: 0.3px;
}
.dormant-hint {
  margin-left: auto;
  font-size: 10px;
  color: rgba(255,255,255,0.35);
  font-family: "Monaco", monospace;
  letter-spacing: 0.3px;
}

/* hint 层 */
.layer-hint {
  align-items: center;
  padding: 0 24px;
  gap: 14px;
  justify-content: center;
}
.hint-text {
  font-size: 16px;
  color: wheat;
  font-weight: 500;
  letter-spacing: 0.5px;
}
.hint-shortcut {
  font-size: 11px;
  color: rgba(255,255,255,0.35);
  margin-left: auto;
  font-family: "Monaco", monospace;
}

/* open 层 */
.layer-open {
  flex-direction: column;
  align-items: stretch;
}
.open-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  font-size: 13px;
  flex-shrink: 0;
}
.open-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: wheat;
  letter-spacing: 0.5px;
}
.open-context {
  font-size: 11px;
  color: rgba(255,255,255,0.5);
  padding: 2px 10px;
  background: rgba(255,255,255,0.04);
  border-radius: 4px;
  font-family: "Monaco", monospace;
}
.open-flex { flex: 1; }
.open-close {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: rgba(255,255,255,0.55);
  cursor: pointer;
  font-size: 18px;
  transition: all 0.15s;
}
.open-close:hover { background: rgba(255,255,255,0.08); color: wheat; }

.open-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.open-empty {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  color: rgba(255,255,255,0.45);
  font-size: 13px;
  text-align: center;
  max-width: 520px;
}
.empty-row em {
  color: wheat;
  font-style: normal;
  padding: 1px 6px;
  background: rgba(245,222,179,0.1);
  border-radius: 4px;
  margin: 0 2px;
}
.quick-tags { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.quick-tag {
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 14px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.7);
  cursor: pointer;
  transition: all 0.15s;
}
.quick-tag:hover {
  background: rgba(245,222,179,0.08);
  border-color: rgba(245,222,179,0.25);
  color: wheat;
}

.msg {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 78%;
  font-size: 13px;
  line-height: 1.65;
}
.msg-user {
  align-self: flex-end;
  background: rgba(245,222,179,0.12);
  border: 1px solid rgba(245,222,179,0.2);
  padding: 8px 14px;
  border-radius: 12px 12px 2px 12px;
  color: wheat;
}
.msg-assistant { align-self: flex-start; color: rgba(255,255,255,0.88); }
.msg-meta { display: inline-flex; align-items: center; gap: 8px; }
.msg-intent {
  font-size: 10px;
  padding: 1px 8px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 1px;
}
.intent-chat { background: rgba(130,170,255,0.16); color: #82aaff; }
.intent-create { background: rgba(105,214,160,0.18); color: #69d6a0; }
.intent-edit { background: rgba(245,222,179,0.18); color: wheat; }
.msg-file-count { font-size: 11px; color: rgba(255,255,255,0.45); font-family: "Monaco", monospace; }
.msg-text { white-space: pre-wrap; }
.waiting-text {
  font-family: "MinecrafterReg", "Monaco", monospace;
  letter-spacing: 1px;
}
.msg-text.streaming::after {
  content: "▌";
  color: wheat;
  margin-left: 2px;
  animation: cursor-blink 1s steps(2) infinite;
}
@keyframes cursor-blink { to { visibility: hidden; } }
.msg-files { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.msg-file {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 6px;
  font-family: "Monaco", monospace;
  font-size: 12px;
  color: rgba(255,255,255,0.75);
  cursor: pointer;
  transition: all 0.15s;
}
.msg-file:hover {
  background: rgba(245,222,179,0.06);
  border-color: rgba(245,222,179,0.25);
  color: wheat;
}
.msg-file-action {
  width: 18px; height: 18px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 4px; font-size: 12px; flex-shrink: 0;
}
.msg-file-action.create { background: rgba(105,214,160,0.18); color: #69d6a0; }
.msg-file-action.edit { background: rgba(245,222,179,0.18); color: wheat; }

.open-input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  padding: 12px 18px 14px;
  border-top: 1px solid rgba(255,255,255,0.05);
  background: rgba(8, 8, 10, 0.5);
  flex-shrink: 0;
}
.open-input {
  flex: 1;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  padding: 9px 12px;
  color: rgba(255,255,255,0.9);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  resize: none;
  min-height: 36px;
  max-height: 180px;
  transition: border-color 0.15s;
}
.open-input:focus { border-color: rgba(245,222,179,0.35); }
.open-input::placeholder { color: rgba(255,255,255,0.3); }
.open-input:disabled { opacity: 0.5; }
.open-send {
  width: 36px; height: 36px;
  border-radius: 8px;
  background: wheat;
  color: #0d0d0f;
  border: none;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
  flex-shrink: 0;
}
.open-send:hover:not(:disabled) { background: #ffe9b5; }
.open-send:disabled { opacity: 0.3; cursor: not-allowed; }
</style>

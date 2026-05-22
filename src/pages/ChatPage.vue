<template>
  <div class="chat-page" :data-tick="streamTick" :data-rawTick="rawMsgTick">
    <div v-for="block in chatBlocks" :key="block.id" class="glass2 chat-block">
      <div v-for="(msg, i) in block.userMessages" :key="i" class="chat-user-input">
        <span v-if="i > 0" class="msg-tag">补充</span>{{ msg }}
      </div>

      <div v-if="block.phase === 'analyzing'" class="streaming-status">
        <span class="streaming-label">分析需求中...</span>
        <div v-if="block.rawMsg" class="streaming-msg" :key="'a-' + block.id">{{ block.rawMsg }}</div>
      </div>

      <!-- 选择缺失参数 -->
      <div v-if="selectingBlock?.id === block.id" class="select-panel">
        <div v-if="missingFields.includes('coreType')" class="select-group">
          <span class="select-label">核心类型</span>
          <span v-for="c in CORE_TYPES" :key="c"
                class="select-chip" :class="{active: selectCore === c}"
                @click="selectCore = c">{{ c }}</span>
        </div>
        <div v-if="missingFields.includes('version')" class="select-group">
          <span class="select-label">版本</span>
          <span v-for="v in VERSIONS" :key="v"
                class="select-chip" :class="{active: selectVer === v}"
                @click="selectVer = v">{{ v }}</span>
        </div>
        <button class="floor-btn" @click="confirmSelect"
                :disabled="(missingFields.includes('coreType') && !selectCore) || (missingFields.includes('version') && !selectVer)">
          确认
        </button>
      </div>

      <div v-if="block.phase === 'fetching'" class="streaming-status">
        <span class="streaming-label">生成步骤中...</span>
        <div v-if="block.rawMsg" class="streaming-msg" :key="'f-' + block.id">{{ block.rawMsg }}</div>
      </div>

      <!-- 渲染结构化步骤 -->
      <StepRender v-if="block.steps && block.steps.length" :block="block"/>

      <!-- 生成项目按钮（仅 draft 状态可点） -->
      <template v-if="block.phase === 'done' && block.steps && block.steps.length && block.draft && genTask.phase === 'idle'">
        <button class="floor-btn" @click="onGenerate(block)">生成项目 & 构建 JAR</button>
        <div class="draft-hint">继续输入可补充需求；点击按钮锁定并生成</div>
      </template>

      <!-- fallback stream -->
      <div v-if="block.streamText" class="chat-stream">{{ block.streamText }}</div>

      <!-- 错误提示 -->
      <div v-if="block.phase === 'error'" class="chat-error">{{ block.error }}</div>
    </div>

    <!-- Reasoner 思考流（折叠） -->
    <div v-if="genTask.reasoningContent" class="glass2 reasoning-wrap">
      <div class="reasoning-head" @click="genTask.reasoningVisible = !genTask.reasoningVisible">
        <span class="reasoning-title">AI 思考中</span>
        <span class="reasoning-toggle">{{ genTask.reasoningVisible ? "收起" : "展开" }}</span>
      </div>
      <div v-if="genTask.reasoningVisible" class="reasoning-body">{{ genTask.reasoningContent }}</div>
    </div>

    <!-- 澄清面板 -->
    <ClarifyPanel v-if="genTask.phase === 'clarifying' && genTask.clarifyTodos.length"/>

    <!-- 需求不明，请求补充描述 -->
    <div v-if="genTask.phase === 'awaiting_input'" class="glass2 more-input-wrap">
      <div class="more-input-hint">{{ genTask.moreInputHint }}</div>
      <div class="more-input-row">
        <input v-model="extraInput" class="more-input-field"
               placeholder="补充你的需求描述..."
               @keydown.enter="sendExtra"/>
        <button class="floor-btn" :disabled="!extraInput.trim()" @click="sendExtra">
          提交补充
        </button>
      </div>
    </div>

    <!-- 生成进度 -->
    <GenerateProgress v-if="genTask.phase !== 'idle' && genTask.phase !== 'clarifying' && genTask.phase !== 'awaiting_input'"/>

    <!-- 输入框 -->
    <div class="glass2 chat-input-wrap">
      <button class="voice-btn" :class="{recording: isRecording}" @click="toggleVoice" :disabled="sending">
        ◉
      </button>
      <input class="chat-input" v-model="inputText" placeholder="描述你的开发需求..."
             @keydown.enter="send" :disabled="sending"/>
      <button class="refresh-btn"
              @click="onRefresh" :disabled="!canRefresh"
              title="重置全部">
        ↻
      </button>
    </div>

    <!-- 重置确认弹窗 -->
    <Teleport to="body">
      <div v-if="showResetModal" class="reset-overlay" @click.self="showResetModal = false">
        <div class="reset-modal glass2">
          <div class="reset-title">确认重置？</div>
          <div class="reset-desc">
            此操作将清空：
            <ul class="reset-list">
              <li>所有聊天记录</li>
              <li>已生成的代码文件（包括 IDE 中的本地编辑）</li>
              <li>当前生成进度与构建状态</li>
            </ul>
            <span class="reset-warning">此操作不可撤销。</span>
          </div>
          <div class="reset-actions">
            <button class="floor-btn reset-cancel" @click="showResetModal = false">取消</button>
            <button class="floor-btn reset-confirm" @click="doReset">确认重置</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import {ref, computed, inject, nextTick, watch} from "vue";
import type {Ref} from "vue";
import type {ChatBlock} from "../logic/chatState";
import {chatBlocks, streamTick, freezeDraft, combineUserMessages, resetChat} from "../logic/chatState";
import {handleUserInput, continueAfterSelect, CORE_TYPES, VERSIONS, getRebuildInfo, clearRebuildInfo} from "../logic/chatHandler";
import StepRender from "../components/StepRender.vue";
import GenerateProgress from "../components/GenerateProgress.vue";
import ClarifyPanel from "../components/ClarifyPanel.vue";
import {genTask, submitExtraPrompt, resetGenTask} from "../logic/generateState";
import {startGenerate} from "../logic/generateHandler";
import {isRecording, voiceText, startVoice, stopVoice} from "../logic/voiceInput";

const centerText = inject<Ref<string>>("centerText")!;

const inputText = ref("");
const extraInput = ref("");
const sending = ref(false);

const showResetModal = ref(false);
const canRefresh = computed(() =>
    !sending.value && ["idle", "done", "error"].includes(genTask.phase)
);

function onRefresh() {
    if (!canRefresh.value) return;
    showResetModal.value = true;
}

async function doReset() {
    showResetModal.value = false;
    const tid = genTask.taskId;
    if (tid) {
        try {
            const {useIDEStore} = await import("../ide/composables/useIDEStore");
            await useIDEStore().resetTask(tid);
        } catch (e) { /* ignore */ }
    }
    resetChat();
    resetGenTask();
    inputText.value = "";
    extraInput.value = "";
}

function sendExtra() {
    const t = extraInput.value.trim();
    if (!t) return;
    extraInput.value = "";
    submitExtraPrompt(t);
}
const rawMsgTick = computed(() => chatBlocks.reduce((s, b) => s + b.rawMsg.length, 0));
let voiceBaseText = "";

const selectingBlock = ref<ChatBlock | null>(null);
const missingFields = ref<("coreType" | "version")[]>([]);
const selectCore = ref("");
const selectVer = ref("");

function canStartGenerate() {
    return ["idle", "done", "error"].includes(genTask.phase);
}

function onNeedSelect(block: ChatBlock, missing: ("coreType" | "version")[]) {
    selectingBlock.value = block;
    missingFields.value = missing;
    selectCore.value = block.coreType || "";
    selectVer.value = block.version || "";
}

async function confirmSelect() {
    const block = selectingBlock.value!;
    if (selectCore.value) block.coreType = selectCore.value;
    if (selectVer.value) block.version = selectVer.value;
    selectingBlock.value = null;
    await continueAfterSelect(block, centerText);
    sending.value = false;
}

function onIncomplete(original: string, hint: string) {
    inputText.value = `${original}\n\n补充方向：${hint}`;
    nextTick(() => {
        const el = document.querySelector(".chat-input") as HTMLInputElement | null;
        if (el) {
            el.focus();
            const len = el.value.length;
            el.setSelectionRange(len, len);
        }
    });
}

async function send() {
    const text = inputText.value.trim();
    if (!text || sending.value) return;
    inputText.value = "";
    sending.value = true;
    await handleUserInput(text, centerText, onNeedSelect, onIncomplete);
    const rebuildInfo = getRebuildInfo();
    if (rebuildInfo && canStartGenerate()) {
        clearRebuildInfo();
        await startGenerate(rebuildInfo.prompt, rebuildInfo.coreType, rebuildInfo.version);
    }
    sending.value = false;
    await nextTick();
    window.scrollTo({top: document.body.scrollHeight, behavior: "smooth"});
}

function onGenerate(block: ChatBlock) {
    if (!block.coreType || !block.version) return;
    freezeDraft();
    const combined = combineUserMessages(block.userMessages);
    startGenerate(combined, block.coreType, block.version);
}

function toggleVoice() {
    if (isRecording.value) {
        stopVoice();
    } else {
        voiceBaseText = inputText.value;
        startVoice();
    }
}

watch(voiceText, (t) => {
    if (isRecording.value) inputText.value = voiceBaseText + t;
});

const phaseLabels: Record<string, string> = {
    planning: "正在规划项目...",
    clarifying: "请确认澄清问题...",
    awaiting_input: "请补充需求描述...",
    generating: "正在生成代码...",
    verifying: "正在校验文件...",
    uploading: "正在上传构建...",
    building: "正在编译打包...",
    polling: "正在编译打包...",
    fixing: "正在修复编译错误...",
    done: "JAR 已就绪",
    error: "生成失败",
};
watch(() => genTask.phase, (p) => {
    if (p !== "idle") centerText.value = phaseLabels[p] || p;
});

</script>

<style scoped>
.chat-page {
  padding: 100px 16px 120px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 900px;
  margin: 0 auto;
}

.chat-block {
  flex-direction: column;
  position: relative;
  height: auto;
  gap: 12px;
}

.chat-user-input {
  font-size: 13px;
  color: #999;
  text-decoration: underline;
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.msg-tag {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  background: rgba(255,255,255,0.08);
  color: wheat;
  text-decoration: none;
}
.draft-hint {
  color: rgba(255,255,255,0.4);
  font-size: 12px;
  margin-top: -4px;
}

.chat-status {
  color: rgba(255,255,255,0.5);
  font-size: 14px;
}

.chat-stream {
  color: white;
  font-size: 15px;
  line-height: 1.6;
  white-space: pre-wrap;
  font-family: system-ui, sans-serif;
}

.chat-error {
  color: #999;
  font-size: 14px;
}

.streaming-status {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
  transition: max-height 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.streaming-label {
  color: rgba(255,255,255,0.45);
  font-size: 13px;
}
.streaming-msg {
  color: rgba(255,255,255,0.9);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  font-family: "Monaco", monospace;
  animation: fadeSlideIn 0.35s ease-out;
}
@keyframes fadeSlideIn {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

.chat-input-wrap {
  position: fixed;
  bottom: 20px;
  left: 16px;
  right: 16px;
  max-width: 900px;
  margin: 0 auto;
  height: auto;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
}

.voice-btn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,0.2);
  background: rgba(255,255,255,0.05);
  color: white;
  font-size: 16px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}
.voice-btn:hover { border-color: rgba(255,255,255,0.4); }
.voice-btn.recording {
  background: rgba(255,80,80,0.3);
  border-color: #ff5050;
  animation: pulse 1s infinite;
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255,80,80,0.4); }
  50% { box-shadow: 0 0 0 8px rgba(255,80,80,0); }
}

.refresh-btn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,0.2);
  background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.85);
  font-size: 18px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}
.refresh-btn:hover:not(:disabled) {
  border-color: wheat;
  color: wheat;
}
.refresh-btn:disabled { opacity: 0.3; cursor: not-allowed; }

.reset-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  animation: overlayIn 0.18s ease-out;
}
@keyframes overlayIn { from { opacity: 0; } to { opacity: 1; } }
.reset-modal {
  flex-direction: column;
  width: min(420px, 90vw);
  padding: 22px 24px 18px;
  gap: 14px;
  height: auto;
  animation: modalIn 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes modalIn {
  from { opacity: 0; transform: translateY(12px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.reset-title {
  font-size: 16px;
  color: wheat;
  letter-spacing: 0.5px;
}
.reset-desc {
  font-size: 13px;
  color: rgba(255,255,255,0.75);
  line-height: 1.7;
}
.reset-list {
  margin: 6px 0 6px 18px;
  padding: 0;
  color: rgba(255,255,255,0.65);
}
.reset-list li { margin: 2px 0; }
.reset-warning {
  display: block;
  margin-top: 4px;
  color: rgba(255,150,150,0.85);
  font-size: 12px;
}
.reset-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 4px;
}
.reset-cancel { margin-top: 0; }
.reset-confirm {
  margin-top: 0;
  background: rgba(255,120,120,0.15);
  border-color: rgba(255,120,120,0.4);
  color: rgba(255,180,180,0.95);
}
.reset-confirm:hover {
  background: rgba(255,120,120,0.25);
  border-color: rgba(255,120,120,0.7);
}

.chat-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: white;
  font-size: 16px;
  font-family: system-ui, sans-serif;
}
.chat-input::placeholder {
  color: rgba(255,255,255,0.3);
}

.select-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.select-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.select-label {
  color: rgba(255,255,255,0.5);
  font-size: 13px;
  margin-right: 4px;
}
.select-chip {
  padding: 4px 14px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.15);
  color: rgba(255,255,255,0.7);
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
  border-color: rgba(255,255,255,0.4);
}

.floor-btn {
  margin-top: 8px;
  padding: 8px 24px;
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 10px;
  background: rgba(255,255,255,0.05);
  color: wheat;
  font-size: 14px;
  cursor: pointer;
  align-self: flex-start;
}
.floor-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.reasoning-wrap {
  flex-direction: column;
  padding: 12px 16px;
  gap: 8px;
  height: auto;
}
.reasoning-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  user-select: none;
}
.reasoning-title {
  color: rgba(255,255,255,0.55);
  font-size: 13px;
}
.reasoning-toggle {
  color: wheat;
  font-size: 12px;
}
.reasoning-body {
  color: rgba(255,255,255,0.75);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  font-family: "Monaco", monospace;
  max-height: 240px;
  overflow-y: auto;
  padding: 8px;
  background: rgba(255,255,255,0.03);
  border-radius: 6px;
}

.more-input-wrap {
  flex-direction: column;
  padding: 16px;
  gap: 12px;
  height: auto;
}
.more-input-hint {
  color: rgba(255,255,255,0.8);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.more-input-row {
  display: flex;
  gap: 10px;
  align-items: center;
}
.more-input-field {
  flex: 1;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  padding: 8px 12px;
  color: #fff;
  font-size: 13px;
  outline: none;
}
.more-input-field:focus {
  border-color: wheat;
}
</style>

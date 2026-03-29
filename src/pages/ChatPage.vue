<template>
  <div class="chat-page" :data-tick="streamTick" :data-rawTick="rawMsgTick">
    <div v-for="block in chatBlocks" :key="block.id" class="glass2 chat-block">
      <div class="chat-user-input">{{ block.userInput }}</div>

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

      <!-- 生成项目按钮 -->
      <button v-if="block.phase === 'done' && block.steps && block.steps.length && genTask.phase === 'idle'"
              class="floor-btn" @click="onGenerate(block)">
        生成项目 & 构建 JAR
      </button>

      <!-- fallback stream -->
      <div v-if="block.streamText" class="chat-stream">{{ block.streamText }}</div>

      <!-- 错误提示 -->
      <div v-if="block.phase === 'error'" class="chat-error">{{ block.error }}</div>
    </div>

    <!-- 生成进度 -->
    <GenerateProgress v-if="genTask.phase !== 'idle'"/>

    <!-- 输入框 -->
    <div class="glass2 chat-input-wrap">
      <button class="voice-btn" :class="{recording: isRecording}" @click="toggleVoice" :disabled="sending">
        🎤
      </button>
      <input class="chat-input" v-model="inputText" placeholder="描述你的开发需求..."
             @keydown.enter="send" :disabled="sending"/>
    </div>
  </div>
</template>

<script setup lang="ts">
import {ref, computed, inject, nextTick, watch} from "vue";
import type {Ref} from "vue";
import type {ChatBlock} from "../logic/chatState";
import {chatBlocks, streamTick} from "../logic/chatState";
import {handleUserInput, continueAfterSelect, CORE_TYPES, VERSIONS, getRebuildInfo, clearRebuildInfo} from "../logic/chatHandler";
import StepRender from "../components/StepRender.vue";
import GenerateProgress from "../components/GenerateProgress.vue";
import {genTask} from "../logic/generateState";
import {startGenerate} from "../logic/generateHandler";
import {isRecording, voiceText, startVoice, stopVoice} from "../logic/voiceInput";

const centerText = inject<Ref<string>>("centerText")!;

const inputText = ref("");
const sending = ref(false);
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

async function send() {
    const text = inputText.value.trim();
    if (!text || sending.value) return;
    inputText.value = "";
    sending.value = true;
    await handleUserInput(text, centerText, onNeedSelect);
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
    startGenerate(block.userInput, block.coreType, block.version);
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
    generating: "正在生成代码...",
    verifying: "正在校验文件...",
    uploading: "正在上传构建...",
    building: "正在编译打包...",
    polling: "正在编译打包...",
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
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  font-family: monospace;
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
</style>

<template>
  <div class="chat-page" :data-tick="streamTick">
    <div v-for="block in chatBlocks" :key="block.id" class="glass2 chat-block">
      <div class="chat-user-input">{{ block.userInput }}</div>

      <div v-if="block.phase === 'analyzing'" class="chat-status">分析中...</div>

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

      <div v-if="block.phase === 'fetching'" class="chat-status">生成步骤中...</div>

      <!-- 渲染结构化步骤 -->
      <StepRender v-if="block.steps && block.steps.length" :block="block"/>

      <!-- fallback stream -->
      <div v-if="block.streamText" class="chat-stream">{{ block.streamText }}</div>

      <!-- 错误提示 -->
      <div v-if="block.phase === 'error'" class="chat-error">{{ block.error }}</div>
    </div>

    <!-- 输入框 -->
    <div class="glass2 chat-input-wrap">
      <input class="chat-input" v-model="inputText" placeholder="描述你的开发需求..."
             @keydown.enter="send" :disabled="sending"/>
    </div>
  </div>
</template>

<script setup lang="ts">
import {ref, inject, nextTick} from "vue";
import type {Ref} from "vue";
import type {ChatBlock} from "../logic/chatState";
import {chatBlocks, streamTick} from "../logic/chatState";
import {handleUserInput, continueAfterSelect, CORE_TYPES, VERSIONS} from "../logic/chatHandler";
import StepRender from "../logic/StepRender.vue";

const centerText = inject<Ref<string>>("centerText")!;

const inputText = ref("");
const sending = ref(false);

const selectingBlock = ref<ChatBlock | null>(null);
const missingFields = ref<("coreType" | "version")[]>([]);
const selectCore = ref("");
const selectVer = ref("");

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
    sending.value = false;
    await nextTick();
    window.scrollTo({top: document.body.scrollHeight, behavior: "smooth"});
}
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

.chat-input-wrap {
  position: fixed;
  bottom: 20px;
  left: 16px;
  right: 16px;
  max-width: 900px;
  margin: 0 auto;
  height: auto;
  z-index: 10;
}

.chat-input {
  width: 100%;
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

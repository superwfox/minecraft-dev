<template>
  <div class="chat-page" :class="{ 'is-focus': inFocusPhase }">

    <!-- ════════ 聚焦阶段：居中输入 + 需求确认 ════════ -->
    <div v-if="inFocusPhase" class="focus-stack">
      <div v-if="statusText" class="focus-status">{{ statusText }}</div>

      <div v-if="activeError" class="focus-error">{{ activeError }}</div>

      <!-- 离题对话回复（fallback） -->
      <div v-if="fallbackText" class="focus-fallback">{{ fallbackText }}</div>

      <!-- Reasoner 思考流（折叠） -->
      <div v-if="genTask.reasoningContent" class="reasoning-wrap glass2">
        <div class="reasoning-head" @click="genTask.reasoningVisible = !genTask.reasoningVisible">
          <span class="reasoning-title">AI 思考中</span>
          <span class="reasoning-toggle">{{ genTask.reasoningVisible ? "收起" : "展开" }}</span>
        </div>
        <div v-if="genTask.reasoningVisible" class="reasoning-body">{{ genTask.reasoningContent }}</div>
      </div>

      <!-- Q&A 收敛：需求确认完成的问答收敛成 ─问/·答 -->
      <div v-if="qaRecap.length" class="qa-recap">
        <div v-for="(qa, i) in qaRecap" :key="i" class="qa-item">
          <div class="qa-q">─{{ qa.q }}</div>
          <div class="qa-a">·{{ qa.a }}</div>
        </div>
      </div>

      <!-- 活动卡：核心类型 / 版本（缺失才弹） -->
      <div v-if="selectingBlock" class="select-panel glass2">
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

      <!-- 活动卡：手牌式需求确认（全屏覆盖） -->
      <ClarifyCards v-if="clarifyWaiting && genTask.clarifyTodos.length"/>

      <!-- 活动卡：手牌式实现路径确认门（全屏覆盖） -->
      <PathCards v-if="pathGateWaiting && genTask.grade && genTask.grade.paths.length"/>

      <!-- 活动卡：需求不明，请求补充 -->
      <div v-if="genTask.phase === 'awaiting_input'" class="more-input-wrap glass2">
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

      <!-- 已选 skill 手牌条 -->
      <div v-if="chosenSkills.length" class="composer-skills">
        <span class="cs-label">手牌</span>
        <span v-for="b in chosenSkills" :key="b.id" class="cs-chip" :title="b.capability || ''">
          {{ b.name || b.id }}
          <button class="cs-x" @click="removeSkill(b.id)" title="移出">✕</button>
        </span>
      </div>

      <!-- 居中聚焦输入框 -->
      <div class="composer glass2" :class="{ disabled: composerDisabled, 'composer-carded': hasSkills }">
        <textarea ref="composerEl" class="composer-input" v-model="inputText"
                  :placeholder="composerPlaceholder" :disabled="composerDisabled"
                  rows="4"
                  @keydown.enter.exact.prevent="send"></textarea>
        <div class="composer-actions">
          <button class="icon-btn voice-btn" :class="{recording: isRecording}"
                  @click="toggleVoice" :disabled="sending" title="语音输入">◉</button>
          <button class="icon-btn refresh-btn" @click="onRefresh" :disabled="!canRefresh" title="重置全部">↻</button>
          <div class="composer-spacer"></div>
          <button class="send-btn" @click="send"
                  :disabled="composerDisabled || !inputText.trim()" title="发送 (Enter)">↑</button>
        </div>
      </div>

      <div class="esc-hint" :class="{ show: canInterrupt }">按 Esc 撤回当前请求（已消耗的 token 将结算）</div>
    </div>

    <!-- ════════ 生成阶段：进度视图 ════════ -->
    <template v-else>
      <GenerateProgress/>
      <button class="reset-fab icon-btn refresh-btn" :disabled="!canRefresh" @click="onRefresh" title="重置 / 新建">↻</button>
    </template>

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

    <SkillTray/>
  </div>
</template>

<script setup lang="ts">
import {ref, computed, inject, nextTick, onMounted, onBeforeUnmount, watch} from "vue";
import type {Ref} from "vue";
import type {ChatBlock} from "../logic/chatState";
import {chatBlocks, resetChat} from "../logic/chatState";
import {handleUserInput, continueAfterSelect, CORE_TYPES, VERSIONS, getRebuildInfo, clearRebuildInfo, interruptAnalyze} from "../logic/chatHandler";
import GenerateProgress from "../components/GenerateProgress.vue";
import ClarifyCards from "../components/ClarifyCards.vue";
import PathCards from "../components/PathCards.vue";
import SkillTray from "../components/SkillTray.vue";
import {selectedBriefs, removeSkill} from "../logic/skills";
import {genTask, submitExtraPrompt, resetGenTask, clarifyWaiting, pathGateWaiting} from "../logic/generateState";
import {startGenerate, interruptGenerate} from "../logic/generateHandler";
import {isRecording, voiceText, startVoice, stopVoice} from "../logic/voiceInput";

const centerText = inject<Ref<string>>("centerText")!;

const inputText = ref("");
const extraInput = ref("");
const sending = ref(false);
const composerEl = ref<HTMLTextAreaElement | null>(null);
const showResetModal = ref(false);

// 缺失参数选择
const selectingBlock = ref<ChatBlock | null>(null);
const missingFields = ref<("coreType" | "version")[]>([]);
const selectCore = ref("");
const selectVer = ref("");

// ── 视图态：尚未产出文件时都用居中聚焦视图；一旦开始生成文件切到进度视图 ──
const inFocusPhase = computed(() => genTask.files.length === 0);

// 已选 skill（手牌）：输入框上方小卡条 + 卡牌质感开关
const chosenSkills = computed(() => selectedBriefs());
const hasSkills = computed(() => chosenSkills.value.length > 0);

const activeDraft = computed(() => chatBlocks.length ? chatBlocks[chatBlocks.length - 1] : null);
const activeError = computed(() => {
    if (genTask.phase === "error" && genTask.error) return genTask.error;
    const b = activeDraft.value;
    return b && b.phase === "error" ? (b.error || "") : "";
});
const fallbackText = computed(() => activeDraft.value?.streamText || "");

// Q&A 收敛：从已确认的澄清历史构建紧凑问答列表
const qaRecap = computed(() => {
    const out: { q: string; a: string }[] = [];
    for (const round of genTask.clarifyHistory) {
        for (const todo of round.todos) {
            const ans = round.answers[todo.id];
            const a = Array.isArray(ans) ? ans.join("、") : (ans ?? "");
            if (!a) continue;
            out.push({ q: todo.question, a: String(a) });
        }
    }
    return out;
});

// 有活动确认卡时，输入框降权禁用（焦点交给上方卡片）
const composerDisabled = computed(() =>
    sending.value
    || !!selectingBlock.value
    || genTask.phase === "clarifying"
    || genTask.phase === "grading"
    || genTask.phase === "confirming"
    || genTask.phase === "awaiting_input"
);
const composerPlaceholder = computed(() =>
    composerDisabled.value && !sending.value
        ? "请在上方完成确认…"
        : "描述你的需求，AI 将与你确认后直接生成插件"
);

const canRefresh = computed(() =>
    !sending.value && ["idle", "done", "error"].includes(genTask.phase)
);

// ESC 仅在思考/需求确认阶段可中断
const canInterrupt = computed(() =>
    sending.value
    || genTask.phase === "clarifying"
    || genTask.phase === "grading"
    || genTask.phase === "confirming"
    || genTask.phase === "awaiting_input"
);

const statusText = computed(() => {
    if (sending.value) return "正在分析需求…";
    if (selectingBlock.value) return "请选择核心类型与版本";
    const p = genTask.phase;
    if (p === "planning") return "正在创建任务…";
    if (p === "clarifying") return clarifyWaiting.value ? "" : "正在生成确认问题…";
    if (p === "grading") return "正在分析需求复杂度…";
    if (p === "confirming") return pathGateWaiting.value ? "" : "正在准备实现路径…";
    if (p === "awaiting_input") return "请补充需求描述";
    if (p === "error") return "请调整需求后重试";
    if (fallbackText.value) return "对话中";
    return ""; // idle：提示语收进输入框 placeholder（见 composerPlaceholder）
});

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
        const el = composerEl.value;
        if (el) {
            el.focus();
            const len = el.value.length;
            el.setSelectionRange(len, len);
        }
    });
}

async function send() {
    const text = inputText.value.trim();
    if (!text || composerDisabled.value) return;
    inputText.value = "";
    sending.value = true;
    try {
        await handleUserInput(text, centerText, onNeedSelect, onIncomplete);
        // 「重新生成」旁路：handleUserInput 仅设置 rebuildInfo 并返回，此处触发生成
        const rebuildInfo = getRebuildInfo();
        if (rebuildInfo && genTask.phase === "idle" && genTask.files.length === 0) {
            clearRebuildInfo();
            startGenerate(rebuildInfo.prompt, rebuildInfo.coreType, rebuildInfo.version).catch(() => {});
        }
    } finally {
        sending.value = false;
    }
}

function sendExtra() {
    const t = extraInput.value.trim();
    if (!t) return;
    extraInput.value = "";
    submitExtraPrompt(t);
}

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
    selectingBlock.value = null;
}

// ── 语音 ──
let voiceBaseText = "";
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

// ── ESC 撤回中断（仅思考/需求确认阶段；token 由后端 waitUntil 自动结算）──
function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !canInterrupt.value) return;
    e.preventDefault();
    interruptAnalyze();   // 中断 analyze（若在分析中）
    interruptGenerate();  // 中断 clarify / awaiting（若在确认中）
    sending.value = false;
    centerText.value = "已中断";
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

// 顶栏中部状态文案
const phaseLabels: Record<string, string> = {
    planning: "正在规划项目...",
    clarifying: "请确认澄清问题...",
    grading: "正在分析复杂度...",
    confirming: "请确认实现路径...",
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

/* 聚焦阶段：整列垂直居中 */
.chat-page.is-focus {
  min-height: 100vh;
  max-width: none;
  padding: 80px 16px 40px;
  justify-content: center;
  align-items: center;
}

.focus-stack {
  width: 100%;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: stretch;
}

.focus-status {
  text-align: center;
  color: rgba(255, 255, 255, 0.65);
  font-size: 15px;
  letter-spacing: 0.5px;
  user-select: none;
}
.focus-error {
  text-align: center;
  color: #ff9a8a;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.focus-fallback {
  color: #fff;
  font-size: 15px;
  line-height: 1.7;
  white-space: pre-wrap;
  font-family: system-ui, sans-serif;
}

/* ── Q&A 收敛 ── */
.qa-recap {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 2px;
}
.qa-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  animation: fadeSlideIn 0.3s ease-out;
}
.qa-q {
  color: rgba(255, 255, 255, 0.85);
  font-size: 14px;
  line-height: 1.5;
}
.qa-a {
  color: wheat;
  font-size: 13px;
  line-height: 1.5;
  padding-left: 2px;
}
@keyframes fadeSlideIn {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ── 聚焦输入框（调胖/变高/变窄）── */
.composer {
  flex-direction: column;
  gap: 12px;
  height: auto;
  min-height: 150px;
  padding: 18px 18px 14px;
  border-radius: 18px;
  transition: opacity 0.2s, border-color 0.2s;
}
.composer.disabled { opacity: 0.55; }

/* 选了 skill 后输入框转为卡牌质感 */
.composer-carded {
  position: relative;
  border: 1px solid rgba(245, 222, 179, 0.4);
  background-image: linear-gradient(155deg, rgba(245, 222, 179, 0.07), rgba(0, 0, 0, 0.05));
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
}
.composer-carded::before {
  content: "";
  position: absolute;
  inset: 6px;
  border-radius: 13px;
  border: 2px dashed rgba(245, 222, 179, 0.22);
  pointer-events: none;
}

/* 已选 skill 手牌条 */
.composer-skills {
  width: 100%;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.cs-label {
  font-size: 12px;
  color: rgba(245, 222, 179, 0.6);
  letter-spacing: 0.05em;
}
.cs-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 11px;
  border-radius: 9px;
  background: rgba(245, 222, 179, 0.14);
  border: 1px solid rgba(245, 222, 179, 0.3);
  color: #f3e7d4;
  font-size: 12.5px;
}
.cs-x {
  border: none;
  background: transparent;
  color: rgba(255, 245, 235, 0.55);
  cursor: pointer;
  font-size: 11px;
  padding: 0 2px;
  border-radius: 5px;
}
.cs-x:hover { color: #ff9a8a; }
.composer-input {
  flex: 1;
  width: 100%;
  min-height: 96px;
  resize: none;
  background: transparent;
  border: none;
  outline: none;
  color: #fff;
  font-size: 16px;
  line-height: 1.6;
  font-family: system-ui, sans-serif;
}
.composer-input::placeholder { color: rgba(255, 255, 255, 0.3); }
.composer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.composer-spacer { flex: 1; }

.icon-btn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.85);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}
.icon-btn:hover:not(:disabled) { border-color: wheat; color: wheat; }
.icon-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.voice-btn.recording {
  background: rgba(255, 80, 80, 0.3);
  border-color: #ff5050;
  color: #fff;
  animation: pulse 1s infinite;
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 80, 80, 0.4); }
  50% { box-shadow: 0 0 0 8px rgba(255, 80, 80, 0); }
}

.send-btn {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: wheat;
  color: #1c1812;
  font-size: 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.2s;
}
.send-btn:hover:not(:disabled) { opacity: 0.85; }
.send-btn:disabled { opacity: 0.35; cursor: not-allowed; }

.esc-hint {
  text-align: center;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.35);
  min-height: 16px;
  opacity: 0;
  transition: opacity 0.25s;
  user-select: none;
}
.esc-hint.show { opacity: 1; }

/* 进度视图右下角的重置 FAB */
.reset-fab {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 30;
  width: 44px;
  height: 44px;
  font-size: 20px;
}

/* ── 核心/版本选择 ── */
.select-panel {
  flex-direction: column;
  gap: 10px;
  height: auto;
  padding: 18px;
}
.select-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.select-label {
  color: rgba(255, 255, 255, 0.5);
  font-size: 13px;
  margin-right: 4px;
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
.select-chip:hover { border-color: rgba(255, 255, 255, 0.4); }

.floor-btn {
  margin-top: 8px;
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

/* ── Reasoner 思考流 ── */
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
  color: rgba(255, 255, 255, 0.55);
  font-size: 13px;
}
.reasoning-toggle {
  color: wheat;
  font-size: 12px;
}
.reasoning-body {
  color: rgba(255, 255, 255, 0.75);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  font-family: "Monaco", monospace;
  max-height: 240px;
  overflow-y: auto;
  padding: 8px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
}

/* ── 补充需求 ── */
.more-input-wrap {
  flex-direction: column;
  padding: 16px;
  gap: 12px;
  height: auto;
}
.more-input-hint {
  color: rgba(255, 255, 255, 0.8);
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
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 8px 12px;
  color: #fff;
  font-size: 13px;
  outline: none;
}
.more-input-field:focus { border-color: wheat; }

/* ── 重置弹窗 ── */
.reset-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
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
  color: rgba(255, 255, 255, 0.75);
  line-height: 1.7;
}
.reset-list {
  margin: 6px 0 6px 18px;
  padding: 0;
  color: rgba(255, 255, 255, 0.65);
}
.reset-list li { margin: 2px 0; }
.reset-warning {
  display: block;
  margin-top: 4px;
  color: rgba(255, 150, 150, 0.85);
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
  background: rgba(255, 120, 120, 0.15);
  border-color: rgba(255, 120, 120, 0.4);
  color: rgba(255, 180, 180, 0.95);
}
.reset-confirm:hover {
  background: rgba(255, 120, 120, 0.25);
  border-color: rgba(255, 120, 120, 0.7);
}
</style>

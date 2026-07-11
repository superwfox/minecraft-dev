<template>
  <div class="chat-page" :class="{ 'is-focus': inFocusPhase }">

    <Transition name="ambient-field">
      <div v-if="ambientVisible" class="ambient-field" aria-hidden="true">
        <Transition name="wedge-swap">
          <div :key="ambientCorner" class="pixel-wedge" :class="`from-${ambientCorner}`">
            <span
              v-for="pixel in ambientPixels"
              :key="pixel.id"
              class="wedge-pixel"
              :style="pixel.style"
            ></span>
          </div>
        </Transition>
      </div>
    </Transition>

    <!-- ════════ 聚焦阶段：居中输入 + 需求确认 ════════ -->
    <div v-if="inFocusPhase" class="focus-stack">
      <div v-if="statusText" class="focus-status">{{ statusText }}</div>

      <div v-if="activeError" class="focus-error">
        <span class="focus-error-msg">{{ activeError }}</span>
        <button v-if="showRetry" class="focus-retry" @click="retryGenerate">↻ 重试</button>
      </div>

      <!-- 离题对话回复（fallback） -->
      <div v-if="fallbackText" class="focus-fallback">{{ fallbackText }}</div>

      <!-- Reasoner 思考流（折叠） -->
      <div v-if="genTask.reasoningContent" class="reasoning-wrap">
        <div class="reasoning-head" @click="genTask.reasoningVisible = !genTask.reasoningVisible">
          <span class="reasoning-title">ai thinking</span>
          <span class="reasoning-toggle">{{ genTask.reasoningVisible ? "收起" : "展开" }}</span>
        </div>
        <div v-if="genTask.reasoningVisible" ref="reasonBodyEl" class="reasoning-body">{{ genTask.reasoningContent }}</div>
      </div>

      <!-- Q&A 收敛：需求确认完成的问答收敛成 ─问/·答 -->
      <div v-if="qaRecap.length" class="qa-recap">
        <div v-for="(qa, i) in qaRecap" :key="i" class="qa-item">
          <div class="qa-q">─{{ qa.q }}</div>
          <div class="qa-a">·{{ qa.a }}</div>
        </div>
      </div>

      <!-- 活动卡：核心类型 / 版本（缺失才弹） -->
      <div v-if="selectingBlock" class="select-panel">
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
      <div v-if="genTask.phase === 'awaiting_input'" class="more-input-wrap">
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

      <!-- 已选 skill 上下文条 -->
      <div v-if="chosenSkills.length" class="composer-skills">
        <span class="cs-label">技能</span>
        <span v-for="b in chosenSkills" :key="b.id" class="cs-chip" :title="b.capability || ''">
          {{ b.name || b.id }}
          <button class="cs-x" @click="removeSkill(b.id)" title="移除技能"><X :size="12"/></button>
        </span>
      </div>

      <!-- Thinking 与输入框共享同一占位，工作态直接替换输入框 -->
      <div class="composer-stage">
        <div v-if="aiWorking" class="focus-marquee"><ThinkingMarquee variant="hero"/></div>

        <div v-else class="composer" :class="{ disabled: composerDisabled }">
          <div class="composer-input-shell">
            <textarea ref="composerEl" class="composer-input" v-model="inputText"
                      :placeholder="composerPlaceholder" :disabled="composerDisabled"
                      rows="2"
                      @keydown.enter.exact.prevent="send"></textarea>
          </div>
          <div class="composer-actions">
            <button class="action-btn voice-btn" :class="{recording: isRecording}"
                    @click="toggleVoice" :disabled="sending" title="语音输入">
              <Square v-if="isRecording" :size="16"/><Mic v-else :size="17"/><span>{{ isRecording ? "停止" : "语音" }}</span>
            </button>
            <button class="action-btn skill-toggle" :class="{ on: trayOpen }" @click="toggleTray" title="技能">
              <Layers3 :size="17"/><span>技能</span>
              <span v-if="selected.length" class="skill-toggle-badge">{{ selected.length }}</span>
            </button>
            <button class="action-btn refresh-btn" @click="onRefresh" :disabled="!canRefresh" title="重置全部"><RotateCcw :size="16"/><span>重置</span></button>
            <div class="composer-spacer"></div>
            <button class="send-btn" @click="send"
                    :disabled="composerDisabled || !inputText.trim()" title="发送 (Enter)"><Send :size="17"/><span>发送</span></button>
          </div>
        </div>
      </div>

      <div class="esc-hint" :class="{ show: canInterrupt }">按 Esc 撤回当前请求（已消耗的 token 将结算）</div>
    </div>

    <!-- ════════ 生成阶段：进度视图 ════════ -->
    <template v-else>
      <GenerateProgress/>
      <button class="reset-fab icon-btn refresh-btn" :disabled="!canRefresh" @click="onRefresh" title="重置 / 新建"><RotateCcw :size="19"/></button>
    </template>

    <!-- 重置确认弹窗 -->
    <Teleport to="body">
      <div v-if="showResetModal" class="reset-overlay" @click.self="showResetModal = false">
        <div class="reset-modal">
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
import ThinkingMarquee from "../components/ThinkingMarquee.vue";
import ClarifyCards from "../components/ClarifyCards.vue";
import PathCards from "../components/PathCards.vue";
import SkillTray from "../components/SkillTray.vue";
import {selectedBriefs, removeSkill, selected, trayOpen, toggleTray} from "../logic/skills";
import {genTask, submitExtraPrompt, resetGenTask, clarifyWaiting, pathGateWaiting, restoreGenTask} from "../logic/generateState";
import {startGenerate, interruptGenerate, retryGenerate, canRetryGenerate, resumeGenerate} from "../logic/generateHandler";
import {isRecording, voiceText, startVoice, stopVoice} from "../logic/voiceInput";
import {Layers3, Mic, RotateCcw, Send, Square, X} from "lucide-vue-next";

const centerText = inject<Ref<string>>("centerText")!;

const inputText = ref("");
const extraInput = ref("");
const lastSubmitted = ref(""); // 记住上次提交的需求，ESC 中断后恢复回输入框
const sending = ref(false);
const composerEl = ref<HTMLTextAreaElement | null>(null);
const reasonBodyEl = ref<HTMLElement | null>(null); // 思考流容器，用于自动粘底
const showResetModal = ref(false);

// 思考流自动跟随到底部:内容增长时,若用户本就贴着底部就跟随滚到底;
// 若用户上翻查看历史(距底 > 60px)则不打扰。pinned 判定在 DOM 更新前读取旧位置,更新后再滚。
watch(() => genTask.reasoningContent, () => {
    const el = reasonBodyEl.value;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (!pinned) return;
    nextTick(() => { if (reasonBodyEl.value) reasonBodyEl.value.scrollTop = reasonBodyEl.value.scrollHeight; });
});

// 缺失参数选择
const selectingBlock = ref<ChatBlock | null>(null);
const missingFields = ref<("coreType" | "version")[]>([]);
const selectCore = ref("");
const selectVer = ref("");

// ── 视图态：尚未产出文件时都用居中聚焦视图；一旦开始生成文件切到进度视图 ──
const inFocusPhase = computed(() => genTask.files.length === 0 && !(genTask.phase === "planning" && !!genTask.taskId));

const AMBIENT_CORNERS = ["tl", "tr", "br", "bl"] as const;
type AmbientCorner = typeof AMBIENT_CORNERS[number];

function seededRandom(seed: number) {
    let state = seed >>> 0;
    return () => {
        state += 0x6D2B79F5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

const ambientRandom = seededRandom(0x0B51D1A);
const ambientPixels = Array.from({length: 68}, (_, id) => {
    // Two fading dotted rays describe the wedge. There is deliberately no filled light field.
    const progress = 0.03 + Math.pow(ambientRandom(), 1.34) * 0.83;
    const edgeJitter = (ambientRandom() - 0.5) * (0.02 + progress * 0.025);
    const onWideEdge = id % 2 === 0;
    const longAxis = progress * 0.94;
    const shortAxis = progress * 0.31;
    const x = Math.min(0.94, Math.max(0.012, (onWideEdge ? longAxis : shortAxis) + edgeJitter));
    const y = Math.min(0.94, Math.max(0.012, (onWideEdge ? shortAxis : longAxis) - edgeJitter));
    const size = Math.round(4 + (1 - progress) * 7 + ambientRandom() * 4);
    const alpha = (0.055 + Math.pow(1 - progress, 1.38) * (0.36 + ambientRandom() * 0.18)).toFixed(3);
    const gray = Math.round(126 + ambientRandom() * 62);
    const edge = Math.min(214, gray + 28);
    const lift = 5 + ambientRandom() * 9;
    const turn = Math.round((ambientRandom() * 2 - 1) * 105);

    return {
        id,
        style: {
            "--x": `${(x * 100).toFixed(2)}%`,
            "--y": `${(y * 100).toFixed(2)}%`,
            "--size": `${size}px`,
            "--alpha": alpha,
            "--pixel-color": `rgb(${gray} ${gray} ${gray})`,
            "--pixel-edge": `rgb(${edge} ${edge} ${edge})`,
            "--delay": `${(-ambientRandom() * 7.5).toFixed(2)}s`,
            "--duration": `${(5.1 + ambientRandom() * 3.4).toFixed(2)}s`,
            "--lift-start": `${(lift * 0.45).toFixed(1)}px`,
            "--lift-peak": `${(-lift).toFixed(1)}px`,
            "--lift-mid": `${(-lift * 0.35).toFixed(1)}px`,
            "--lift-end": `${(lift * 0.28).toFixed(1)}px`,
            "--turn-start": `${(-turn * 0.35).toFixed(1)}deg`,
            "--turn-peak": `${turn}deg`,
            "--turn-mid": `${(turn * 0.58).toFixed(1)}deg`,
            "--turn-end": `${(-turn * 0.18).toFixed(1)}deg`,
        },
    };
});

// The ambient field exists only before the first valid request. Restored tasks never flash it.
const ambientReady = ref(false);
const ambientDismissed = ref(
    genTask.phase !== "idle"
    || !!genTask.taskId
    || genTask.files.length > 0
    || chatBlocks.length > 0
);
const ambientVisible = computed(() =>
    ambientReady.value
    && inFocusPhase.value
    && genTask.phase === "idle"
    && !ambientDismissed.value
);
const ambientCorner = ref<AmbientCorner>(AMBIENT_CORNERS[0]);
const prefersReducedMotion = ref(false);
let ambientCornerIndex = 0;
let ambientCycleTimer: number | undefined;
let motionQuery: MediaQueryList | null = null;

function stopAmbientCycle() {
    if (ambientCycleTimer === undefined) return;
    window.clearInterval(ambientCycleTimer);
    ambientCycleTimer = undefined;
}

function startAmbientCycle() {
    stopAmbientCycle();
    if (!ambientVisible.value || prefersReducedMotion.value) return;
    ambientCycleTimer = window.setInterval(() => {
        ambientCornerIndex = (ambientCornerIndex + 1) % AMBIENT_CORNERS.length;
        ambientCorner.value = AMBIENT_CORNERS[ambientCornerIndex];
    }, 12000);
}

function resetAmbientCycle() {
    stopAmbientCycle();
    ambientCornerIndex = 0;
    ambientCorner.value = AMBIENT_CORNERS[0];
    startAmbientCycle();
}

function onMotionPreferenceChange(event: MediaQueryListEvent) {
    prefersReducedMotion.value = event.matches;
    if (event.matches) stopAmbientCycle();
    else startAmbientCycle();
}

watch(ambientVisible, (visible) => {
    if (visible) startAmbientCycle();
    else stopAmbientCycle();
});

// AI 正在「后台思考」（非流式、无逐字流）→ 显示跑马灯缓解等待
const aiWorking = computed(() =>
    (sending.value && !selectingBlock.value)
    || (["clarifying", "grading", "planning"].includes(genTask.phase)
        && !clarifyWaiting.value && !pathGateWaiting.value)
);
const showRetry = computed(() => canRetryGenerate() && genTask.phase === "error");

// 已选 skill：输入框上方的紧凑上下文条
const chosenSkills = computed(() => selectedBriefs());

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
    ambientDismissed.value = true;
    lastSubmitted.value = text;
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
    lastSubmitted.value = "";
    centerText.value = "";
    selectingBlock.value = null;
    ambientDismissed.value = false;
    resetAmbientCycle();
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
    // 恢复中断前的需求输入，方便用户改了再发
    if (!inputText.value && lastSubmitted.value) inputText.value = lastSubmitted.value;
}
// 刷新恢复：若上次生成态还在（且当前是全新页面 idle），还原并按阶段续跑，避免刷新即失败。
onMounted(() => {
    window.addEventListener("keydown", onKeydown);
    motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    prefersReducedMotion.value = motionQuery.matches;
    motionQuery.addEventListener("change", onMotionPreferenceChange);

    if (genTask.phase === "idle" && !genTask.taskId && restoreGenTask()) {
        ambientDismissed.value = true;
        // done/error 只还原展示；进行中的阶段交给 resumeGenerate 续跑
        if (!["done", "error", "idle"].includes(genTask.phase)) {
            resumeGenerate().catch(() => { });
        }
    }

    ambientReady.value = true;
    startAmbientCycle();
});

onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKeydown);
    motionQuery?.removeEventListener("change", onMotionPreferenceChange);
    motionQuery = null;
    stopAmbientCycle();
});

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
  --surface: #040402;
  --surface-raised: #090907;
  --graphite: #1a1a18;
  --graphite-hover: #262626;
  --line: rgba(209, 200, 182, 0.18);
  --line-bright: rgba(209, 200, 182, 0.46);
  --text: #e8e3d9;
  --muted: #88847d;
  --warm: #bcb7ad;
  --warm-light: #e8e3d9;
  min-height: 100vh;
  width: 100%;
  padding: 100px 16px 120px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 0 auto;
  box-sizing: border-box;
  position: relative;
  background: #000;
  color: var(--text);
  font-family: system-ui, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
}

/* 聚焦阶段：整列垂直居中 */
.chat-page.is-focus {
  min-height: 100vh;
  padding: 112px 18px 44px;
  justify-content: safe center;
  align-items: center;
  overflow-x: hidden;
}

.focus-stack {
  position: relative;
  z-index: 1;
  width: min(640px, 100%);
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: stretch;
}

/* The light cone is defined only by pixel distribution; the canvas stays pure black. */
.ambient-field {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background: transparent;
  contain: strict;
}
.ambient-field-enter-active,
.ambient-field-leave-active {
  transition: opacity 0.58s ease;
}
.ambient-field-enter-from,
.ambient-field-leave-to {
  opacity: 0;
}
.pixel-wedge {
  position: absolute;
  inset: 0;
  opacity: 0.86;
  will-change: opacity;
}
.wedge-swap-enter-active,
.wedge-swap-leave-active {
  transition: opacity 1.35s cubic-bezier(0.4, 0, 0.2, 1);
}
.wedge-swap-leave-active { position: absolute; }
.wedge-swap-enter-from,
.wedge-swap-leave-to { opacity: 0; }
.wedge-pixel {
  position: absolute;
  width: var(--size);
  height: var(--size);
  box-sizing: border-box;
  border: 1px solid var(--pixel-edge);
  border-radius: 1px;
  background: var(--pixel-color);
  box-shadow: inset 1px 1px 0 rgba(255, 255, 255, 0.18), inset -1px -1px 0 rgba(0, 0, 0, 0.48);
  opacity: var(--alpha);
  animation: wedgePixel var(--duration) cubic-bezier(0.22, 0.7, 0.26, 1) var(--delay) infinite;
  will-change: transform, opacity;
}
.from-tl .wedge-pixel { left: var(--x); top: var(--y); }
.from-tr .wedge-pixel { right: var(--x); top: var(--y); }
.from-br .wedge-pixel { right: var(--x); bottom: var(--y); }
.from-bl .wedge-pixel { left: var(--x); bottom: var(--y); }
@keyframes wedgePixel {
  0%, 100% {
    opacity: 0;
    transform: translate3d(0, var(--lift-start), 0) rotate(var(--turn-start)) scale(0.25);
  }
  18% {
    opacity: var(--alpha);
    transform: translate3d(0, 0, 0) rotate(0deg) scale(0.86);
  }
  42% {
    opacity: var(--alpha);
    transform: translate3d(0, var(--lift-peak), 0) rotate(var(--turn-peak)) scale(1.08);
  }
  64% {
    opacity: calc(var(--alpha) * 0.72);
    transform: translate3d(0, var(--lift-mid), 0) rotate(var(--turn-mid)) scale(0.78);
  }
  82% {
    opacity: 0;
    transform: translate3d(0, var(--lift-end), 0) rotate(var(--turn-end)) scale(0.38);
  }
}

.focus-status {
  text-align: center;
  color: var(--muted);
  font-size: 13px;
  line-height: 20px;
  letter-spacing: 0;
  user-select: none;
}
.composer-stage {
  width: 100%;
  height: 116px;
  flex: 0 0 116px;
}
.focus-marquee {
  width: 100%;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--surface);
  box-shadow: inset 0 1px 0 rgba(244, 241, 236, 0.035);
}
.focus-marquee {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px;
  --oak-border: var(--line-bright);
  --oak-highlight: #d5c9ac;
}
.focus-error {
  text-align: center;
  color: #df8f8a;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.focus-error-msg { white-space: pre-wrap; }
.focus-retry {
  padding: 7px 18px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  background: var(--graphite);
  border: 1px solid var(--line-bright);
  border-radius: 6px;
  cursor: pointer;
  transition: color 0.18s, border-color 0.18s, background 0.18s;
}
.focus-retry:hover {
  color: #fff;
  background: var(--graphite-hover);
  border-color: #777d84;
}
.focus-retry:focus-visible { outline: 2px solid #aeb3b8; outline-offset: 2px; }
.focus-fallback {
  color: #d2d5d8;
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
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
  padding-left: 2px;
}
@keyframes fadeSlideIn {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ── 聚焦输入框 ── */
.composer {
  width: 100%;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0;
  background: transparent;
  border: 0;
  transition: opacity 0.2s;
}
.composer-input-shell {
  flex: 1;
  min-height: 0;
  display: flex;
  padding: 12px 14px 10px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(5, 5, 3, 0.84);
  backdrop-filter: blur(22px) saturate(88%);
  -webkit-backdrop-filter: blur(22px) saturate(88%);
  box-shadow:
    inset 0 1px 0 rgba(244, 241, 236, 0.04),
    0 14px 38px rgba(0, 0, 0, 0.24);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.composer-input-shell:focus-within {
  border-color: var(--line-bright);
  box-shadow:
    inset 0 1px 0 rgba(244, 241, 236, 0.07),
    0 0 0 1px rgba(232, 227, 217, 0.08),
    0 12px 32px rgba(0, 0, 0, 0.22);
}
.composer.disabled { opacity: 0.58; }

/* 已选 skill 上下文条 */
.composer-skills {
  width: 100%;
  min-height: 24px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.cs-label {
  font-family: "MinecrafterAlt", sans-serif;
  font-size: 10px;
  color: rgba(209, 200, 182, 0.42);
  margin-right: 4px;
}
.cs-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 24px;
  padding: 1px 3px 1px 8px;
  border-radius: 4px;
  background: rgba(198, 176, 125, 0.055);
  border: 1px solid rgba(198, 176, 125, 0.2);
  color: rgba(213, 201, 172, 0.82);
  font-size: 11px;
}
.cs-x {
  width: 19px;
  height: 19px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  border-radius: 3px;
}
.cs-x:hover { color: #f4f1ec; background: rgba(209, 200, 182, 0.08); }
.cs-x:focus-visible { outline: 2px solid rgba(213, 201, 172, 0.7); outline-offset: 1px; }
.composer-input {
  flex: 1;
  width: 100%;
  min-height: 0;
  padding: 0;
  box-sizing: border-box;
  resize: none;
  background: transparent;
  border: none;
  outline: none;
  color: #f4f1ec;
  caret-color: var(--warm-light);
  font: 400 15px/1.48 system-ui, "Noto Sans SC", "PingFang SC", sans-serif;
}
.composer-input::placeholder { color: rgba(232, 227, 217, 0.4); opacity: 1; }
.composer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0;
}
.composer-spacer { flex: 1; }

.action-btn,
.send-btn {
  position: relative;
  top: 0;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 11px;
  border-radius: 8px;
  border: 1px solid rgba(232, 227, 217, 0.2);
  border-bottom-color: rgba(232, 227, 217, 0.09);
  background: rgba(8, 8, 6, 0.78);
  color: rgba(232, 227, 217, 0.76);
  box-shadow: 0 2px 0 #000, inset 0 1px 0 rgba(255, 255, 255, 0.05);
  font: 12px/1 system-ui, "Noto Sans SC", sans-serif;
  cursor: pointer;
  transition: top 0.1s, color 0.16s, border-color 0.16s, background 0.16s, box-shadow 0.1s;
}
.action-btn:hover:not(:disabled) {
  color: #f4f1ec;
  border-color: rgba(209, 200, 182, 0.48);
  border-bottom-color: rgba(209, 200, 182, 0.18);
  background: rgba(209, 200, 182, 0.06);
}
.action-btn:focus-visible,
.send-btn:focus-visible { outline: 2px solid rgba(213, 201, 172, 0.72); outline-offset: 3px; }
.action-btn:active:not(:disabled),
.send-btn:active:not(:disabled) {
  top: 1px;
  box-shadow: 0 1px 0 #000, inset 0 1px 0 rgba(244, 241, 236, 0.04);
}
.action-btn:disabled,
.send-btn:disabled { opacity: 0.35; cursor: not-allowed; }

.voice-btn,
.skill-toggle,
.refresh-btn { background: rgba(4, 4, 2, 0.66); }
.voice-btn:hover:not(:disabled),
.skill-toggle:hover:not(:disabled),
.refresh-btn:hover:not(:disabled) { background: rgba(209, 200, 182, 0.06); }

.icon-btn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 6px;
  border: 1px solid #4b5055;
  border-bottom-color: #151719;
  background: #28272b;
  color: #d5d8db;
  box-shadow: 0 3px 0 #050506, inset 0 1px 0 rgba(255, 255, 255, 0.12);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.16s, border-color 0.16s, background 0.16s;
}
.icon-btn:hover:not(:disabled) { border-color: #666c72; color: #fff; background: #333238; }
.icon-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.icon-btn:focus-visible { outline: 2px solid #b9bdc1; outline-offset: 3px; }
.skill-toggle.on {
  border-color: rgba(198, 176, 125, 0.66);
  color: #d5c9ac;
  background: rgba(198, 176, 125, 0.08);
}
.skill-toggle-badge {
  position: absolute;
  top: -7px;
  right: -7px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: #d5c9ac;
  color: #040402;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}
.voice-btn.recording {
  background: #2a1718;
  border-color: #9b4949;
  color: #f0b0ac;
  animation: pulse 1s infinite;
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(191, 80, 80, 0.28); }
  50% { box-shadow: 0 0 0 6px rgba(191, 80, 80, 0); }
}

.send-btn {
  flex-shrink: 0;
  min-width: 76px;
  background: var(--warm-light);
  border-color: #f2eee6;
  border-bottom-color: #817d74;
  color: #070706;
  box-shadow: 0 2px 0 #504d47, inset 0 1px 0 #fff;
  font-weight: 700;
}
.send-btn:hover:not(:disabled) {
  background: #f2eee6;
  border-color: #fff;
  border-bottom-color: #8f8a80;
}
.send-btn:active:not(:disabled) {
  box-shadow: 0 1px 0 #504d47, inset 0 1px 0 rgba(255, 255, 255, 0.5);
}

.esc-hint {
  text-align: center;
  font-size: 12px;
  color: #6f747a;
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
  background: #202225;
  border-color: #4b5055;
}

/* ── 核心/版本选择 ── */
.select-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: auto;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-raised);
}
.select-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.select-label {
  color: var(--muted);
  font-size: 13px;
  margin-right: 4px;
}
.select-chip {
  padding: 4px 14px;
  border-radius: 6px;
  border: 1px solid #4b5055;
  background: var(--graphite);
  color: #d2d5d8;
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.select-chip.active {
  background: #d2d5d8;
  color: #111214;
  border-color: #f0f1f2;
}
.select-chip:hover:not(.active) { border-color: #747a80; color: #fff; }

.floor-btn {
  margin-top: 8px;
  padding: 8px 24px;
  border: 1px solid #4b5055;
  border-radius: 6px;
  background: var(--graphite);
  color: #d5d8db;
  font-size: 14px;
  cursor: pointer;
  align-self: flex-start;
}
.floor-btn:hover:not(:disabled) { background: var(--graphite-hover); border-color: #747a80; color: #fff; }
.floor-btn:focus-visible { outline: 2px solid #b9bdc1; outline-offset: 2px; }
.floor-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* ── Reasoner 思考流 ── */
.reasoning-wrap {
  display: flex;
  flex-direction: column;
  padding: 12px 16px;
  gap: 8px;
  height: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-raised);
}
.reasoning-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  user-select: none;
}
.reasoning-title {
  font-family: "MinecrafterReg", "Monaco", monospace;
  color: var(--muted);
  font-size: 13px;
  letter-spacing: 0;
}
.reasoning-toggle {
  color: #d6d9dc;
  font-size: 12px;
}
.reasoning-body {
  color: #c6c9cc;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  font-family: "Monaco", monospace;
  max-height: 240px;
  overflow-y: auto;
  padding: 8px;
  background: #08090a;
  border: 1px solid var(--line);
  border-radius: 6px;
}

/* ── 补充需求 ── */
.more-input-wrap {
  display: flex;
  flex-direction: column;
  padding: 16px;
  gap: 12px;
  height: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-raised);
}
.more-input-hint {
  color: #cbd0d4;
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
  background: #08090a;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 12px;
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.more-input-field:focus { border-color: var(--line-bright); }

/* ── 重置弹窗 ── */
.reset-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.78);
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
  display: flex;
  flex-direction: column;
  width: min(420px, 90vw);
  padding: 22px 24px 18px;
  gap: 14px;
  height: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-raised);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.58);
  animation: modalIn 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes modalIn {
  from { opacity: 0; transform: translateY(12px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.reset-title {
  font-size: 16px;
  color: var(--text);
  letter-spacing: 0;
}
.reset-desc {
  font-size: 13px;
  color: #c4c8cc;
  line-height: 1.7;
}
.reset-list {
  margin: 6px 0 6px 18px;
  padding: 0;
  color: var(--muted);
}
.reset-list li { margin: 2px 0; }
.reset-warning {
  display: block;
  margin-top: 4px;
  color: #dc8b87;
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
  background: #281719;
  border-color: #6f3739;
  color: #e5a19d;
}
.floor-btn.reset-confirm:hover:not(:disabled) {
  background: #351b1e;
  border-color: #9a4a4d;
  color: #efb0ac;
}

@media (max-height: 760px) {
  .chat-page.is-focus { padding-top: 88px; }
  .composer-stage { height: 112px; flex-basis: 112px; }
}

@media (max-width: 700px) {
  .wedge-pixel:nth-child(n + 43) { display: none; }
  .pixel-wedge { opacity: 0.82; }
}

@media (max-width: 520px) {
  .chat-page.is-focus { padding: 96px 12px 32px; }
  .composer-stage { height: 110px; flex-basis: 110px; }
  .composer { gap: 8px; }
  .composer-input-shell { padding: 10px 11px 8px; }
  .composer-input { font-size: 14px; }
  .action-btn { width: 32px; padding: 0; }
  .send-btn { width: 36px; min-width: 36px; padding: 0; }
  .action-btn > span:not(.skill-toggle-badge),
  .send-btn > span { display: none; }
  .more-input-row { align-items: stretch; flex-direction: column; }
  .more-input-row .floor-btn { width: 100%; margin-top: 0; }
  .wedge-pixel:nth-child(n + 31) { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .ambient-field-enter-active,
  .ambient-field-leave-active,
  .wedge-swap-enter-active,
  .wedge-swap-leave-active { transition: none; }
  .wedge-pixel,
  .qa-item,
  .voice-btn.recording,
  .reset-overlay,
  .reset-modal { animation: none; }
}
</style>

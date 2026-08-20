<template>
  <div class="chat-page" :class="{ 'is-focus': inFocusPhase }">

    <!-- ════════ 聚焦阶段：居中输入 + 需求确认 ════════ -->
    <div v-if="inFocusPhase" class="focus-stack">
      <Transition name="welcome-collapse">
        <div v-if="showWelcome" class="focus-welcome">
          <Blocks :size="42" :stroke-width="1.35" aria-hidden="true"/>
          <h1>
            <span>今天想构建什么</span>
            <template v-if="welcomeLogin">
              <span>，</span>
              <span class="welcome-user" :title="welcomeLogin">{{ welcomeLogin }}</span>
            </template>
            <span>？</span>
          </h1>
        </div>
      </Transition>

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

      <!-- 已选 skill 上下文条 -->
      <div v-if="chosenSkills.length" class="composer-skills">
        <span class="cs-label">技能</span>
        <span v-for="b in chosenSkills" :key="b.id" class="cs-chip" :title="b.capability || ''">
          {{ b.name || b.id }}
          <button class="cs-x" :disabled="composerDisabled" @click="removeSkill(b.id)" title="移除技能"><X :size="12"/></button>
        </span>
      </div>

      <div
        class="composer-stage"
        :class="{
          'is-processing': liveProcessVisible,
          'has-guidance': !!activeIncomplete,
          'has-message': !!composerMessage,
          'has-assistant-message': composerMessage?.kind === 'assistant_content',
        }"
      >
        <div class="composer" :class="{ disabled: composerDisabled }">
          <div class="composer-input-shell" :class="{ 'is-processing': liveProcessVisible }">
            <!-- 前置阶段的 thinking / output 与输入框共用一个聊天栏容器 -->
            <section v-if="liveProcessVisible" class="live-process" aria-live="polite">
              <div class="live-process-head">
                <span class="live-process-status">
                  <LoaderCircle v-if="liveProcessActive" class="live-spinner" :size="15" aria-hidden="true"/>
                  <span>{{ liveStageLabel }}</span>
                </span>
                <button
                  v-if="activeThinking"
                  type="button"
                  class="thinking-toggle"
                  :aria-expanded="genTask.reasoningVisible"
                  @click="toggleThinking"
                >
                  <BrainCircuit :size="14" aria-hidden="true"/>
                  <span>思考</span>
                  <ChevronUp v-if="genTask.reasoningVisible" :size="14" aria-hidden="true"/>
                  <ChevronDown v-else :size="14" aria-hidden="true"/>
                </button>
              </div>
              <div ref="liveBodyEl" class="live-process-body" @scroll.passive="onLiveScroll">
                <div v-if="activeThinking && genTask.reasoningVisible" class="live-thinking">
                  <span class="live-section-label">思考过程</span>
                  <pre>{{ activeThinking }}</pre>
                </div>
                <div v-if="activeOutput" class="live-output">
                  <span class="live-section-label">输出</span>
                  <pre>{{ activeOutput }}</pre>
                </div>
                <div v-else-if="liveProcessActive" class="live-waiting">等待首个响应片段…</div>
              </div>
              <button
                v-if="!livePinned"
                type="button"
                class="live-scroll-bottom"
                title="回到底部"
                aria-label="回到底部"
                @click="scrollLiveToBottom(true)"
              ><ArrowDownToLine :size="15"/></button>
            </section>

            <template v-else>
              <div
                v-if="composerMessage"
                class="composer-message"
                :class="`is-${composerMessage.kind}`"
                :role="composerMessage.kind === 'error' ? 'alert' : 'status'"
                :aria-live="composerMessage.kind === 'error' ? 'assertive' : 'polite'"
              >
                <span class="composer-message-icon" aria-hidden="true">
                  <component
                    :is="composerMessageIcon"
                    :size="18"
                    :class="{ 'is-spinning': composerMessage.kind === 'progress' }"
                  />
                </span>
                <div class="composer-message-copy">
                  <strong>{{ composerMessage.title }}</strong>
                  <span v-if="composerMessage.detail" class="composer-message-detail">{{ composerMessage.detail }}</span>
                </div>
                <div v-if="composerMessage.actions.length" class="composer-message-actions">
                  <button
                    v-for="action in composerMessage.actions"
                    :key="action.id"
                    type="button"
                    class="composer-message-action"
                    :class="{ primary: action.primary }"
                    :disabled="composerMessageActionDisabled(action.id)"
                    @click="runComposerMessageAction(action.id)"
                  >
                    <component :is="composerActionIcons[action.id]" :size="15" aria-hidden="true"/>
                    <span>{{ action.label }}</span>
                  </button>
                </div>
              </div>

              <div v-if="activeIncomplete" class="incomplete-guidance" aria-live="polite">
                <div class="incomplete-guidance-head">
                  <ListChecks :size="16" aria-hidden="true"/>
                  <span>{{ activeIncomplete.heading }}</span>
                </div>
                <ol class="incomplete-guidance-list">
                  <li v-for="item in activeIncomplete.items" :key="item.topic + ':' + item.detail">
                    <strong>{{ item.topic }}</strong><span v-if="item.detail">：{{ item.detail }}</span>
                  </li>
                </ol>
              </div>
              <div v-if="genTask.phase === 'awaiting_input'" class="more-input-wrap">
                <div class="more-input-row">
                  <input v-model="extraInput" class="more-input-field"
                         placeholder="补充你的需求描述..."
                         @compositionstart="onImeCompositionStart"
                         @compositionend="onImeCompositionEnd"
                         @keydown.enter="onExtraEnter"/>
                  <button class="floor-btn" :disabled="!extraInput.trim()" @click="sendExtra">
                    提交补充
                  </button>
                </div>
              </div>
              <MarkdownComposer
                v-else
                ref="composerEl"
                v-model="inputText"
                class="composer-input"
                :placeholder="composerPlaceholder"
                :disabled="composerDisabled"
                @submit="send"
                @composition-start="onComposerCompositionStart"
                @composition-end="onComposerCompositionEnd"
              />
            </template>
            <div class="composer-actions">
              <button class="action-btn skill-toggle" :class="{ on: trayOpen }" :disabled="composerDisabled" @click="toggleTray" title="技能">
                <Layers3 :size="17"/><span>技能</span>
                <span v-if="selected.length" class="skill-toggle-badge">{{ selected.length }}</span>
              </button>
              <span class="composer-mode"><Blocks :size="15" aria-hidden="true"/><span>插件生成</span></span>
              <button
                v-if="formatPhase === 'loading'"
                type="button"
                class="action-btn format-action"
                disabled
                title="正在整理需求"
              ><LoaderCircle class="format-spinner" :size="16"/><span>整理中</span></button>
              <button
                v-else-if="formatPhase === 'ready'"
                type="button"
                class="action-btn format-action ready"
                title="应用格式化结果"
                @click="applyFormattedPrompt"
              ><WandSparkles :size="16"/><span>应用格式</span></button>
              <button
                v-if="formatUndo"
                type="button"
                class="action-btn icon-action"
                title="撤销格式化"
                aria-label="撤销格式化"
                @click="undoFormattedPrompt"
              ><Undo2 :size="16"/></button>
              <div class="composer-spacer"></div>
              <button class="action-btn icon-action refresh-btn" @click="onRefresh" :disabled="!canRefresh" title="重置全部" aria-label="重置全部">
                <RotateCcw :size="16"/>
              </button>
              <button class="send-btn icon-action" @click="send"
                      :disabled="composerDisabled || !inputText.trim()" title="发送 (Enter)" aria-label="发送"><Send :size="17"/></button>
            </div>
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

    <button
      v-if="inFocusPhase && (clarifyWaiting || pathGateWaiting)"
      class="reset-fab icon-btn refresh-btn"
      :disabled="!canRefresh"
      @click="onRefresh"
      title="重置 / 新建"
      aria-label="重置 / 新建"
    ><RotateCcw :size="19"/></button>

    <!-- 重置确认弹窗 -->
    <Teleport to="body">
      <div v-if="showResetModal" class="reset-overlay" @click.self="closeResetModal">
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
          <div v-if="resetError" class="reset-error" role="alert">{{ resetError }}</div>
          <div class="reset-actions">
            <button class="floor-btn reset-cancel" :disabled="resetting" @click="closeResetModal">取消</button>
            <button class="floor-btn reset-confirm" :disabled="resetting" @click="doReset">
              {{ resetting ? "正在重置…" : "确认重置" }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <SkillTray/>
  </div>
</template>

<script setup lang="ts">
import {ref, computed, inject, nextTick, onMounted, onBeforeUnmount, watch} from "vue";
import type {Component, Ref} from "vue";
import type {ChatBlock} from "../logic/chatState";
import {chatBlocks, removeChatBlock, removeDraftBlock, resetChat} from "../logic/chatState";
import {handleUserInput, resumeInterruptedAnalysis, continueAfterSelect, CORE_TYPES, VERSIONS, getRebuildInfo, clearRebuildInfo, interruptAnalyze} from "../logic/chatHandler";
import {formatUserPrompt} from "../api/deepseek";
import {createIdlePromptScheduler, shouldAcceptFormattedPrompt} from "../logic/promptFormatting";
import type {PrecheckGuidance} from "../logic/promptFormatting";
import GenerateProgress from "../components/GenerateProgress.vue";
import ClarifyCards from "../components/ClarifyCards.vue";
import MarkdownComposer from "../components/MarkdownComposer.vue";
import PathCards from "../components/PathCards.vue";
import SkillTray from "../components/SkillTray.vue";
import {selectedBriefs, removeSkill, selected, trayOpen, toggleTray} from "../logic/skills";
import {genTask, submitExtraPrompt, resetGenTask, clarifyWaiting, pathGateWaiting, restoreGenTask} from "../logic/generateState";
import {startGenerate, interruptGenerate, retryGenerate, canRetryGenerate, resumeGenerate} from "../logic/generateHandler";
import {isImeComposing, onImeCompositionEnd, onImeCompositionStart} from "../logic/keyboard";
import {authState, login, showSponsorModal} from "../logic/auth";
import {hasDeepSeekKey, openDeepSeekKeyModal} from "../logic/byok";
import type {ActionMessageKind, ActionMessageMeta} from "../logic/actionMessages";
import {clearSession, persistSession} from "../logic/sessionPersist";
import {
    ArrowDownToLine,
    Blocks,
    BrainCircuit,
    ChevronDown,
    ChevronUp,
    CircleAlert,
    CircleCheck,
    Info,
    KeyRound,
    Layers3,
    ListChecks,
    LoaderCircle,
    LogIn,
    MessageSquareText,
    PauseCircle,
    Pencil,
    Play,
    RotateCcw,
    Send,
    TriangleAlert,
    Undo2,
    WandSparkles,
    WalletCards,
    X,
} from "lucide-vue-next";

const centerText = inject<Ref<string>>("centerText")!;

const inputText = ref("");
const extraInput = ref("");
const lastSubmitted = ref(""); // 记住上次提交的需求，ESC 中断后恢复回输入框
const sending = ref(false);
const composerEl = ref<{ focusEnd: () => void } | null>(null);
const liveBodyEl = ref<HTMLElement | null>(null);
const livePinned = ref(true);
const showResetModal = ref(false);
const resetting = ref(false);
const resetError = ref("");
const resumingInterrupted = ref(false);

type FormatPhase = "idle" | "debouncing" | "loading" | "ready";
type FormatUndo = {before: string; after: string};
type ComposerMessageActionId =
    | "login"
    | "manage_quota"
    | "configure_key"
    | "retry"
    | "continue_draft"
    | "edit_draft"
    | "continue_generation";
type ComposerMessageAction = {
    id: ComposerMessageActionId;
    label: string;
    primary?: boolean;
};
type ComposerMessage = {
    kind: ActionMessageKind;
    title: string;
    detail: string;
    actions: ComposerMessageAction[];
};
type ActiveErrorState = {
    text: string;
    meta: ActionMessageMeta;
    source: "draft" | "generation";
};

const composerMessageIcons: Record<ActionMessageKind, Component> = {
    progress: LoaderCircle,
    guidance: ListChecks,
    action_required: CircleAlert,
    auth_required: LogIn,
    quota_required: WalletCards,
    credential_required: KeyRound,
    interrupted: PauseCircle,
    assistant_content: MessageSquareText,
    warning: CircleAlert,
    error: TriangleAlert,
    success: CircleCheck,
    helper: Info,
};
const composerActionIcons: Record<ComposerMessageActionId, Component> = {
    login: LogIn,
    manage_quota: WalletCards,
    configure_key: KeyRound,
    retry: RotateCcw,
    continue_draft: Play,
    edit_draft: Pencil,
    continue_generation: Play,
};
const FORMAT_IDLE_MS = 3_000;
const formatPhase = ref<FormatPhase>("idle");
const formatPreview = ref("");
const formatSource = ref("");
const formatUndo = ref<FormatUndo | null>(null);
const composerComposing = ref(false);
let formatAbort: AbortController | null = null;
let formatRevision = 0;
const promptFormatScheduler = createIdlePromptScheduler((source) => {
    void requestPromptFormat(source, formatRevision);
}, FORMAT_IDLE_MS);

// 缺失参数选择
const selectingBlock = ref<ChatBlock | null>(null);
const missingFields = ref<("coreType" | "version")[]>([]);
const selectCore = ref("");
const selectVer = ref("");

// ── 视图态：尚未产出文件时都用居中聚焦视图；一旦开始生成文件切到进度视图 ──
const inFocusPhase = computed(() => genTask.files.length === 0);

// 前置阶段连接尚未返回首个片段时，保留明确的工作态。
const aiWorking = computed(() =>
    (sending.value && !selectingBlock.value)
    || (["clarifying", "grading", "planning"].includes(genTask.phase)
        && !clarifyWaiting.value && !pathGateWaiting.value)
);

// 已选 skill：输入框上方的紧凑上下文条
const chosenSkills = computed(() => selectedBriefs());

const activeDraft = computed(() => chatBlocks.length ? chatBlocks[chatBlocks.length - 1] : null);
const activeIncomplete = computed(() =>
    activeDraft.value?.phase === "needs_input"
        ? activeDraft.value.incompleteGuidance || null
        : null
);
const activeInterruptedDraft = computed(() =>
    activeDraft.value?.phase === "interrupted" ? activeDraft.value : null
);
const draftWorkActive = computed(() => {
    const phase = activeDraft.value?.phase;
    return !!phase && ["analyzing", "fetching", "rendering", "streaming"].includes(phase);
});
const generationWorkActive = computed(() =>
    !["idle", "done", "error", "interrupted"].includes(genTask.phase)
);
const showWelcome = computed(() =>
    genTask.phase === "idle"
    && !activeDraft.value
    && !selectingBlock.value
    && !sending.value
    && inputText.value.length === 0
);
const welcomeLogin = computed(() => authState.user?.login?.trim() || "");
const fallbackText = computed(() => activeDraft.value?.streamText || "");
const statusText = computed(() => {
    if (sending.value) return "正在分析需求…";
    if (selectingBlock.value) return "请选择核心类型与版本";
    const p = genTask.phase;
    if (p === "planning") return "正在创建任务…";
    if (p === "clarifying") return clarifyWaiting.value ? "" : "正在生成确认问题…";
    if (p === "grading") return "正在分析需求复杂度…";
    if (p === "confirming") return pathGateWaiting.value ? "" : "正在准备实现路径…";
    if (p === "awaiting_input") return "请补充需求描述";
    if (p === "interrupted") return "";
    if (p === "error") return "请调整需求后重试";
    if (fallbackText.value) return "对话中";
    return "";
});
const currentPreflightStage = computed<"" | "clarify" | "grade" | "plan">(() => {
    if (genTask.phase === "clarifying") return "clarify";
    if (genTask.phase === "grading") return "grade";
    if (genTask.phase === "planning") return "plan";
    return "";
});
const hasCurrentPreflightStream = computed(() =>
    !!currentPreflightStage.value
    && genTask.preflightStage === currentPreflightStage.value
);
const activeThinking = computed(() => {
    if (hasCurrentPreflightStream.value) return genTask.preflightThinking;
    return activeDraft.value?.thinkingText || "";
});
const activeOutput = computed(() => {
    if (hasCurrentPreflightStream.value) return genTask.preflightOutput;
    const draft = activeDraft.value;
    if (!draft) return "";
    return draft.phase === "streaming" ? draft.streamText : (draft.outputText || "");
});
const liveProcessActive = computed(() =>
    sending.value
    || genTask.preflightActive
    || draftWorkActive.value
    || aiWorking.value
);
const liveProcessVisible = computed(() =>
    !selectingBlock.value
    && !clarifyWaiting.value
    && !pathGateWaiting.value
    && activeDraft.value?.phase !== "error"
    && (genTask.phase !== "error" || sending.value || draftWorkActive.value)
    && genTask.phase !== "awaiting_input"
    && (liveProcessActive.value || !!activeThinking.value || !!activeOutput.value)
);
const liveStageLabel = computed(() => {
    if (currentPreflightStage.value === "clarify") return "正在确认需求细节";
    if (currentPreflightStage.value === "grade") return "正在分析实现复杂度";
    if (currentPreflightStage.value === "plan") return "正在规划项目结构";
    if (activeDraft.value?.streamStage === "precheck") return "正在检查需求完整性";
    if (activeDraft.value?.streamStage === "analysis") return "正在识别插件目标";
    if (activeDraft.value?.streamStage === "chat") return "正在回复";
    return statusText.value || "正在处理需求";
});
const activeErrorState = computed<ActiveErrorState | null>(() => {
    const b = activeDraft.value;
    if (b?.phase === "error" && b.error) {
        return {
            text: b.error,
            meta: b.errorMeta || {kind: "error"},
            source: "draft",
        };
    }
    if (sending.value || draftWorkActive.value || genTask.phase !== "error" || !genTask.error) return null;
    return {
        text: genTask.error,
        meta: genTask.errorMeta || {kind: "error"},
        source: "generation",
    };
});
const showRetry = computed(() =>
    canRetryGenerate()
    && genTask.phase === "error"
    && !sending.value
    && !draftWorkActive.value
    && activeDraft.value?.phase !== "error"
);

function recoveryActionFor(error: ActiveErrorState): ComposerMessageAction | null {
    if (error.source === "draft") return {id: "edit_draft", label: "重新编辑"};
    if (showRetry.value) return {id: "retry", label: "重试"};
    return null;
}

function messageForError(error: ActiveErrorState): ComposerMessage {
    const recovery = recoveryActionFor(error);
    const actions: ComposerMessageAction[] = [];
    if (error.meta.kind === "auth_required") {
        if (!authState.user) actions.push({id: "login", label: "登录", primary: true});
        else if (recovery) actions.push({...recovery, primary: true});
        return {
            kind: "auth_required",
            title: authState.user ? "登录状态已恢复" : "登录后继续",
            detail: authState.user
                ? "当前需求没有自动重新发送，请手动继续。"
                : "登录后即可使用 Chat，当前需求不会自动重新发送。",
            actions,
        };
    }
    if (error.meta.kind === "quota_required") {
        const deepSeekQuota = error.meta.code === "INSUFFICIENT_QUOTA"
            || (!error.meta.code && hasDeepSeekKey());
        actions.push({id: "manage_quota", label: deepSeekQuota ? "处理额度" : "充值额度", primary: true});
        if (recovery) actions.push(recovery);
        return {
            kind: "quota_required",
            title: "可用额度不足",
            detail: error.text,
            actions,
        };
    }
    if (error.meta.kind === "credential_required") {
        actions.push({id: "configure_key", label: "配置 Key", primary: true});
        if (recovery) actions.push(recovery);
        return {
            kind: "credential_required",
            title: "需要配置 API Key",
            detail: error.text,
            actions,
        };
    }
    if (recovery) actions.push({...recovery, primary: true});
    return {
        kind: error.meta.kind === "warning" ? "warning" : "error",
        title: error.meta.kind === "warning" ? "需要处理后继续" : "请求未完成",
        detail: error.text,
        actions,
    };
}

const composerMessage = computed<ComposerMessage | null>(() => {
    if (liveProcessVisible.value || activeIncomplete.value) return null;
    if (activeInterruptedDraft.value) {
        return {
            kind: "interrupted",
            title: "需求处理已中断",
            detail: "原始需求已保留，不会自动继续。",
            actions: [
                {id: "continue_draft", label: "继续", primary: true},
                {id: "edit_draft", label: "重新编辑"},
            ],
        };
    }
    if (genTask.phase === "interrupted") {
        return {
            kind: "interrupted",
            title: "生成任务已中断",
            detail: "当前进度已保存，只会在你手动继续后恢复。",
            actions: [{id: "continue_generation", label: "继续任务", primary: true}],
        };
    }
    if (activeErrorState.value) return messageForError(activeErrorState.value);
    if (genTask.phase === "awaiting_input") {
        return {
            kind: "action_required",
            title: "还需要一段补充说明",
            detail: genTask.moreInputHint || "请补充需求中的具体行为、条件或边界。",
            actions: [],
        };
    }
    if (fallbackText.value) {
        return {
            kind: "assistant_content",
            title: "回复",
            detail: fallbackText.value,
            actions: [],
        };
    }
    if (selectingBlock.value) {
        return {
            kind: "action_required",
            title: "需要确认插件信息",
            detail: "请选择核心类型与 Minecraft 版本。",
            actions: [],
        };
    }
    if (genTask.phase === "error") {
        return {
            kind: "warning",
            title: "需要调整需求",
            detail: "请检查当前需求后再重试。",
            actions: showRetry.value ? [{id: "retry", label: "重试", primary: true}] : [],
        };
    }
    if (statusText.value) {
        return {
            kind: "progress",
            title: statusText.value,
            detail: "",
            actions: [],
        };
    }
    return null;
});
const composerMessageIcon = computed<Component>(() =>
    composerMessage.value ? composerMessageIcons[composerMessage.value.kind] : Info
);

function onLiveScroll() {
    const el = liveBodyEl.value;
    if (!el) return;
    livePinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

async function scrollLiveToBottom(force = false) {
    if (!force && !livePinned.value) return;
    await nextTick();
    const el = liveBodyEl.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    livePinned.value = true;
}

function toggleThinking() {
    const expanding = !genTask.reasoningVisible;
    genTask.reasoningVisible = expanding;
    void scrollLiveToBottom(expanding);
}

// 思考和输出共用滚动容器；用户主动上滚后暂停跟随，回到底部后恢复。
watch([activeThinking, activeOutput], () => {
    void scrollLiveToBottom();
}, {flush: "post"});

watch(liveProcessVisible, (visible) => {
    if (!visible) return;
    livePinned.value = true;
    void scrollLiveToBottom(true);
}, {flush: "post", immediate: true});

watch(liveStageLabel, () => {
    if (liveProcessVisible.value) void scrollLiveToBottom(true);
}, {flush: "post"});

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
    || activeDraft.value?.phase === "streaming"
    || !!selectingBlock.value
    || generationWorkActive.value
);
const composerPlaceholder = computed(() =>
    composerDisabled.value
        ? (clarifyWaiting.value || pathGateWaiting.value || genTask.phase === "awaiting_input"
            ? "请先完成上方确认"
            : "正在处理当前需求")
        : "描述你想制作的 Minecraft 插件"
);

function cancelFormatRequest() {
    formatAbort?.abort();
    formatAbort = null;
}

function resetFormatOffer(clearUndo = false, forgetLastRequested = false) {
    formatRevision++;
    promptFormatScheduler.reset({forgetLastRequested});
    cancelFormatRequest();
    formatPhase.value = "idle";
    formatPreview.value = "";
    formatSource.value = "";
    if (clearUndo) formatUndo.value = null;
}

function formatterEligible(text: string): boolean {
    return !!text.trim()
        && !!authState.user
        && !composerDisabled.value
        && !composerComposing.value
        && !liveProcessVisible.value;
}

async function requestPromptFormat(source: string, requestRevision: number) {
    if (requestRevision !== formatRevision || !formatterEligible(source) || inputText.value !== source) return;
    const controller = new AbortController();
    formatAbort = controller;
    formatPhase.value = "loading";
    try {
        const formatted = await formatUserPrompt(source, controller.signal);
        if (!shouldAcceptFormattedPrompt({
            source,
            current: inputText.value,
            requestRevision,
            currentRevision: formatRevision,
            formatted,
            aborted: controller.signal.aborted,
            composing: composerComposing.value,
            disabled: composerDisabled.value,
        })) {
            if (requestRevision === formatRevision) formatPhase.value = "idle";
            return;
        }
        formatSource.value = source;
        formatPreview.value = formatted;
        formatPhase.value = "ready";
    } catch (error: any) {
        if (error?.name !== "AbortError" && requestRevision === formatRevision) {
            formatPhase.value = "idle";
        }
    } finally {
        if (formatAbort === controller) formatAbort = null;
    }
}

function schedulePromptFormatting() {
    const text = inputText.value;
    formatRevision++;
    cancelFormatRequest();
    formatPreview.value = "";
    formatSource.value = "";

    if (formatUndo.value && text !== formatUndo.value.after) formatUndo.value = null;
    formatPhase.value = promptFormatScheduler.schedule(text, formatterEligible(text));
}

function applyFormattedPrompt() {
    const before = inputText.value;
    const after = formatPreview.value;
    if (formatPhase.value !== "ready" || !after || formatSource.value !== before) return;
    resetFormatOffer();
    formatUndo.value = {before, after};
    promptFormatScheduler.suppressNext(after);
    inputText.value = after;
    nextTick(() => composerEl.value?.focusEnd());
}

function undoFormattedPrompt() {
    const undo = formatUndo.value;
    if (!undo || inputText.value !== undo.after) {
        formatUndo.value = null;
        return;
    }
    resetFormatOffer();
    formatUndo.value = null;
    promptFormatScheduler.suppressNext(undo.before);
    inputText.value = undo.before;
    nextTick(() => composerEl.value?.focusEnd());
}

function onComposerCompositionStart() {
    composerComposing.value = true;
    resetFormatOffer();
}

function onComposerCompositionEnd() {
    composerComposing.value = false;
    nextTick(schedulePromptFormatting);
}

watch(
    [inputText, composerDisabled, composerComposing, () => authState.user],
    schedulePromptFormatting,
    {flush: "post"},
);

watch(composerDisabled, (disabled) => {
    if (disabled) trayOpen.value = false;
}, { immediate: true });

const canRefresh = computed(() => !showResetModal.value && !resetting.value);

// 所有非终态工作都允许通过 Esc 中断，等待输入的阶段也会停止自动恢复。
const canInterrupt = computed(() =>
    sending.value
    || draftWorkActive.value
    || generationWorkActive.value
);

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

function onIncomplete(original: string, _guidance: PrecheckGuidance) {
    inputText.value = original;
    nextTick(() => composerEl.value?.focusEnd());
}

async function continueInterruptedDraft() {
    const draft = activeInterruptedDraft.value;
    if (!draft || resumingInterrupted.value) return;
    resumingInterrupted.value = true;
    sending.value = true;
    lastSubmitted.value = draft.userMessages.join("\n\n");
    try {
        await resumeInterruptedAnalysis(draft, centerText, onNeedSelect, onIncomplete);
    } finally {
        sending.value = false;
        resumingInterrupted.value = false;
    }
}

function editInterruptedDraft() {
    const draft = activeInterruptedDraft.value;
    if (!draft || resumingInterrupted.value) return;
    const original = draft.userMessages.join("\n\n");
    removeDraftBlock(draft);
    selectingBlock.value = null;
    centerText.value = "";
    inputText.value = original;
    nextTick(() => composerEl.value?.focusEnd());
}

function editErroredDraft() {
    const draft = activeDraft.value;
    if (!draft || draft.phase !== "error" || resumingInterrupted.value) return;
    const original = draft.userMessages.join("\n\n");
    removeChatBlock(draft);
    centerText.value = "";
    inputText.value = original;
    nextTick(() => composerEl.value?.focusEnd());
}

function composerMessageActionDisabled(action: ComposerMessageActionId): boolean {
    if (action === "continue_draft" || action === "continue_generation") return resumingInterrupted.value;
    if (action === "edit_draft") return resumingInterrupted.value;
    if (action === "retry") return sending.value || draftWorkActive.value;
    return false;
}

function runComposerMessageAction(action: ComposerMessageActionId) {
    if (composerMessageActionDisabled(action)) return;
    if (action === "login") {
        login();
        return;
    }
    if (action === "manage_quota") {
        const deepSeekQuota = activeErrorState.value?.meta.code === "INSUFFICIENT_QUOTA"
            || (!activeErrorState.value?.meta.code && hasDeepSeekKey());
        if (deepSeekQuota) {
            openDeepSeekKeyModal("billing", activeErrorState.value?.text || "请处理 DeepSeek 账户额度后重试。");
        } else {
            showSponsorModal.value = true;
        }
        return;
    }
    if (action === "configure_key") {
        const reason = activeErrorState.value?.meta.code === "LLM_AUTH_FAILED" ? "invalid" : "missing";
        openDeepSeekKeyModal(reason, activeErrorState.value?.text || "请配置可用的 DeepSeek API Key 后重试。");
        return;
    }
    if (action === "retry") {
        retryGenerate();
        return;
    }
    if (action === "continue_draft") {
        void continueInterruptedDraft();
        return;
    }
    if (action === "continue_generation") {
        void continueInterruptedGeneration();
        return;
    }
    if (activeInterruptedDraft.value) editInterruptedDraft();
    else editErroredDraft();
}

async function continueInterruptedGeneration() {
    if (genTask.phase !== "interrupted" || resumingInterrupted.value) return;
    resumingInterrupted.value = true;
    try {
        await resumeGenerate();
    } finally {
        resumingInterrupted.value = false;
    }
}

async function send() {
    const text = inputText.value.trim();
    if (!text || composerDisabled.value) return;
    resetFormatOffer(true, true);
    trayOpen.value = false;
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

function onExtraEnter(event: KeyboardEvent) {
    if (isImeComposing(event)) return;
    event.preventDefault();
    sendExtra();
}

function onRefresh() {
    if (!canRefresh.value) return;
    resetError.value = "";
    showResetModal.value = true;
}

function closeResetModal() {
    if (resetting.value) return;
    showResetModal.value = false;
    resetError.value = "";
}

async function deleteRemoteTask(taskId: string): Promise<void> {
    if (!taskId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
        const response = await fetch(`/api/generate/task?taskId=${encodeURIComponent(taskId)}`, {
            method: "DELETE",
            signal: controller.signal,
        });
        // 重试重置时，404 表示上一次删除已成功，可继续清理本地状态。
        if (response.ok || response.status === 404) return;
        const payload = await response.json().catch(() => null) as {error?: string} | null;
        throw new Error(payload?.error || `服务端任务删除失败（HTTP ${response.status}）`);
    } catch (error: any) {
        if (error?.name === "AbortError") throw new Error("服务端任务删除超时，请稍后重试。");
        throw error;
    } finally {
        window.clearTimeout(timer);
    }
}

function cancelCurrentWork(updateStatus = false) {
    resetFormatOffer(true);
    interruptAnalyze(updateStatus ? centerText : undefined);
    interruptGenerate();
    sending.value = false;
    selectingBlock.value = null;
    if (updateStatus) centerText.value = "已中断";
}

async function doReset() {
    if (resetting.value) return;
    resetting.value = true;
    resetError.value = "";
    trayOpen.value = false;
    const tid = genTask.taskId;
    cancelCurrentWork();
    persistSession();
    try {
        await deleteRemoteTask(tid);
        if (tid) {
            const {useIDEStore} = await import("../ide/composables/useIDEStore");
            await useIDEStore().resetTask(tid);
        }
        resetChat();
        clearSession();
        resetGenTask();
        inputText.value = "";
        extraInput.value = "";
        lastSubmitted.value = "";
        centerText.value = "";
        selectingBlock.value = null;
        resetFormatOffer(true, true);
        showResetModal.value = false;
    } catch (error: any) {
        resetError.value = error?.message || "重置失败，请稍后重试。";
    } finally {
        resetting.value = false;
    }
}

// 抽屉使用捕获阶段兜底，避免 SkillTray 先关闭后，冒泡监听误判为撤回请求。
function onTrayEscapeCapture(e: KeyboardEvent) {
    if (e.key !== "Escape" || !trayOpen.value) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    trayOpen.value = false;
}

// ── ESC 撤回中断：覆盖 Chat 分析与完整生成链路 ──
function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (trayOpen.value) {
        e.preventDefault();
        trayOpen.value = false;
        return;
    }
    if (formatPhase.value === "debouncing" || formatPhase.value === "loading" || formatPhase.value === "ready") {
        e.preventDefault();
        resetFormatOffer();
        return;
    }
    const shouldInterrupt = canInterrupt.value;
    if (!shouldInterrupt) return;
    e.preventDefault();
    cancelCurrentWork(true);
}

function onPageHide() {
    cancelCurrentWork();
    persistSession();
}
// 刷新恢复：活动快照会在 restoreGenTask 内转成 interrupted，只允许用户手动继续。
onMounted(() => {
    window.addEventListener("keydown", onTrayEscapeCapture, true);
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pagehide", onPageHide);

    if (genTask.phase === "idle" && !genTask.taskId) {
        restoreGenTask();
    }
    if (activeIncomplete.value && !inputText.value) {
        inputText.value = activeDraft.value?.userMessages.join("\n\n") || "";
    }

});

onBeforeUnmount(() => {
    window.removeEventListener("keydown", onTrayEscapeCapture, true);
    window.removeEventListener("keydown", onKeydown);
    window.removeEventListener("pagehide", onPageHide);
    trayOpen.value = false;
    cancelCurrentWork();
    persistSession();
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
    interrupted: "任务已中断",
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
  --accent: #d77a52;
  min-height: 100vh;
  width: 100%;
  padding: 100px 16px 120px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 0 auto;
  box-sizing: border-box;
  position: relative;
  background: #11110f;
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
  width: min(1000px, 100%);
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: stretch;
}

.focus-welcome {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  max-height: 76px;
  margin-bottom: 30px;
  overflow: hidden;
  color: var(--accent);
}
.welcome-collapse-enter-active,
.welcome-collapse-leave-active {
  overflow: hidden;
  transition: opacity 0.22s ease, transform 0.22s ease, max-height 0.25s ease, margin-bottom 0.25s ease;
}
.welcome-collapse-enter-from,
.welcome-collapse-leave-to {
  max-height: 0;
  margin-bottom: 0;
  opacity: 0;
  transform: translateY(-8px);
}
.focus-welcome h1 {
  display: flex;
  align-items: baseline;
  justify-content: center;
  min-width: 0;
  max-width: min(780px, calc(100vw - 110px));
  margin: 0;
  color: #f0ede7;
  font-family: "Jiangxizhuokai", "Songti SC", "STSong", serif;
  font-size: 46px;
  font-weight: 400;
  line-height: 1.2;
  letter-spacing: 0;
  white-space: nowrap;
}
.welcome-user {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.composer-stage {
  width: 100%;
  height: 190px;
  flex: 0 0 190px;
  min-height: 0;
  transition: height 0.24s ease, flex-basis 0.24s ease;
}
.composer-stage.is-processing {
  height: min(560px, calc(100vh - 220px));
  min-height: 360px;
  flex-basis: min(560px, calc(100vh - 220px));
}
.composer-stage.has-guidance {
  height: min(420px, calc(100vh - 240px));
  min-height: 340px;
  flex-basis: min(420px, calc(100vh - 240px));
}
.composer-stage.has-message {
  height: min(340px, calc(100vh - 240px));
  min-height: 300px;
  flex-basis: min(340px, calc(100vh - 240px));
}
.composer-stage.has-assistant-message {
  height: min(420px, calc(100vh - 220px));
  min-height: 340px;
  flex-basis: min(420px, calc(100vh - 220px));
}

/* ── Q&A 收敛 ── */
.qa-recap {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 2px;
  font-family: "Jiangxizhuokai", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
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
  gap: 0;
  padding: 0;
  background: transparent;
  border: 0;
  transition: opacity 0.2s;
}
.composer-input-shell {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px 20px 14px;
  border: 1px solid rgba(232, 227, 217, 0.2);
  border-radius: 14px;
  background: rgba(28, 28, 26, 0.94);
  backdrop-filter: blur(22px) saturate(88%);
  -webkit-backdrop-filter: blur(22px) saturate(88%);
  box-shadow:
    inset 0 1px 0 rgba(244, 241, 236, 0.04),
    0 18px 48px rgba(0, 0, 0, 0.3);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.composer-input-shell:focus-within {
  border-color: var(--line-bright);
  box-shadow:
    inset 0 1px 0 rgba(244, 241, 236, 0.07),
    0 0 0 1px rgba(232, 227, 217, 0.08),
    0 12px 32px rgba(0, 0, 0, 0.22);
}
.composer-message {
  --message-accent: rgba(157, 185, 190, 0.92);
  --message-border: rgba(92, 142, 151, 0.3);
  --message-bg: rgba(53, 105, 115, 0.08);
  flex: 0 0 auto;
  min-width: 0;
  min-height: 58px;
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 12px 14px;
  border: 1px solid var(--message-border);
  border-radius: 6px;
  background: var(--message-bg);
  color: rgba(232, 227, 217, 0.76);
}
.composer-message.is-action_required,
.composer-message.is-auth_required,
.composer-message.is-quota_required,
.composer-message.is-credential_required,
.composer-message.is-interrupted,
.composer-message.is-warning {
  --message-accent: rgba(224, 202, 151, 0.94);
  --message-border: rgba(198, 176, 125, 0.32);
  --message-bg: rgba(198, 176, 125, 0.075);
}
.composer-message.is-error {
  --message-accent: rgba(232, 153, 145, 0.96);
  --message-border: rgba(220, 120, 112, 0.34);
  --message-bg: rgba(111, 55, 57, 0.13);
}
.composer-message.is-success {
  --message-accent: rgba(166, 207, 179, 0.96);
  --message-border: rgba(111, 171, 131, 0.32);
  --message-bg: rgba(67, 120, 85, 0.11);
}
.composer-message.is-assistant_content {
  --message-accent: rgba(193, 202, 199, 0.9);
  --message-border: rgba(193, 202, 199, 0.2);
  --message-bg: rgba(193, 202, 199, 0.045);
  min-height: 0;
}
.composer-message-icon {
  flex: 0 0 22px;
  width: 22px;
  min-height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--message-accent);
}
.composer-message-icon .is-spinning {
  animation: liveSpin 1.1s linear infinite;
}
.composer-message-copy {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  line-height: 1.55;
}
.composer-message-copy strong {
  color: var(--message-accent);
  font-size: 13px;
  font-weight: 700;
}
.composer-message-detail {
  color: rgba(232, 227, 217, 0.7);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.composer-message.is-assistant_content .composer-message-detail {
  max-height: 150px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding-right: 6px;
  color: rgba(232, 227, 217, 0.82);
  font-size: 13px;
  line-height: 1.65;
}
.composer-message-actions {
  flex: 0 0 auto;
  align-self: center;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.composer-message-action {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid rgba(232, 227, 217, 0.18);
  border-radius: 6px;
  background: rgba(8, 8, 6, 0.68);
  color: rgba(232, 227, 217, 0.76);
  font-size: 12px;
  font-weight: 650;
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
}
.composer-message-action.primary {
  border-color: var(--message-border);
  background: var(--message-bg);
  color: var(--message-accent);
}
.composer-message-action:hover:not(:disabled) {
  border-color: rgba(232, 227, 217, 0.42);
  color: #fff;
}
.composer-message-action:focus-visible {
  outline: 2px solid rgba(213, 201, 172, 0.72);
  outline-offset: 2px;
}
.composer-message-action:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.composer.disabled .composer-input { opacity: 0.58; }

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
  min-height: 28px;
  padding: 4px 4px 4px 10px;
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
.cs-x:hover:not(:disabled) { color: #f4f1ec; background: rgba(209, 200, 182, 0.08); }
.cs-x:focus-visible { outline: 2px solid rgba(213, 201, 172, 0.7); outline-offset: 1px; }
.cs-x:disabled { opacity: 0.35; cursor: not-allowed; }
.composer-input {
  flex: 1;
  width: 100%;
  min-height: 92px;
  padding: 0;
  box-sizing: border-box;
  resize: none;
  background: transparent;
  border: none;
  outline: none;
  color: #f4f1ec;
  caret-color: var(--warm-light);
  font: 400 16px/1.52 system-ui, "Noto Sans SC", "PingFang SC", sans-serif;
}
.composer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 12px 0 0;
  border-top: 1px solid rgba(232, 227, 217, 0.09);
}
.composer-spacer { flex: 1; }

.composer-mode {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  padding: 0 10px;
  color: rgba(232, 227, 217, 0.58);
  font-size: 12px;
  white-space: nowrap;
}

.action-btn,
.send-btn {
  position: relative;
  top: 0;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 13px;
  border-radius: 6px;
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

.skill-toggle,
.refresh-btn { background: rgba(4, 4, 2, 0.66); }
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
.send-btn {
  flex-shrink: 0;
  min-width: 38px;
  background: var(--warm-light);
  border-color: #f2eee6;
  border-bottom-color: #817d74;
  color: #070706;
  box-shadow: 0 2px 0 #504d47, inset 0 1px 0 #fff;
  font-weight: 700;
}
.icon-action {
  width: 38px;
  min-width: 38px;
  padding: 0;
}
.format-action.ready {
  border-color: rgba(215, 122, 82, 0.58);
  background: rgba(215, 122, 82, 0.1);
  color: #efb092;
}
.format-action.ready:hover:not(:disabled) {
  border-color: rgba(235, 150, 111, 0.76);
  background: rgba(215, 122, 82, 0.16);
  color: #ffd1bb;
}
.format-spinner {
  flex: 0 0 auto;
  animation: liveSpin 1.1s linear infinite;
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

/* ── FileGen 前置思考流：与输入框共用容器和滚动区 ── */
.composer-input-shell.is-processing {
  gap: 12px;
}
.live-process {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.live-process-head {
  flex: 0 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 32px;
  gap: 12px;
}
.live-process-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 2px 4px 8px 0;
}
.live-process-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: rgba(232, 227, 217, 0.72);
  font-size: 13px;
  line-height: 1.4;
}
.live-spinner {
  flex: 0 0 auto;
  color: var(--accent);
  animation: liveSpin 1.1s linear infinite;
}
@keyframes liveSpin { to { transform: rotate(360deg); } }
.thinking-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 6px 10px;
  border: 1px solid rgba(232, 227, 217, 0.14);
  border-radius: 6px;
  background: rgba(232, 227, 217, 0.035);
  color: rgba(232, 227, 217, 0.68);
  font-size: 12px;
  cursor: pointer;
}
.thinking-toggle:hover { color: #f4f1ec; border-color: rgba(232, 227, 217, 0.3); }
.thinking-toggle:focus-visible { outline: 2px solid rgba(213, 201, 172, 0.72); outline-offset: 2px; }
.live-thinking {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
  color: rgba(198, 201, 204, 0.82);
  padding: 12px 14px;
  background: rgba(5, 5, 4, 0.72);
  border-left: 2px solid rgba(232, 227, 217, 0.2);
}
.live-output {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 12px 14px;
  border-left: 2px solid var(--accent);
  background: rgba(215, 122, 82, 0.035);
}
.live-section-label {
  color: rgba(232, 227, 217, 0.48);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
}
.live-thinking pre,
.live-output pre {
  margin: 0;
  color: inherit;
  font: 12px/1.65 "Monaco", "Noto Sans SC", monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.live-output pre {
  color: #ece8df;
  font-size: 13px;
}
.live-waiting {
  flex: 1;
  min-height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  color: var(--muted);
  font-size: 12px;
}
.live-scroll-bottom {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid rgba(232, 227, 217, 0.24);
  border-radius: 6px;
  background: rgba(18, 18, 16, 0.96);
  color: rgba(232, 227, 217, 0.76);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.34);
  cursor: pointer;
}
.live-scroll-bottom:hover {
  color: #fff;
  border-color: rgba(232, 227, 217, 0.48);
}
.live-scroll-bottom:focus-visible {
  outline: 2px solid rgba(213, 201, 172, 0.72);
  outline-offset: 2px;
}

/* ── 需求完整性提示 ── */
.incomplete-guidance {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 2px 2px 14px;
  border-bottom: 1px solid rgba(232, 227, 217, 0.1);
  color: rgba(232, 227, 217, 0.82);
}
.incomplete-guidance-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  color: rgba(222, 214, 197, 0.92);
  font-size: 13px;
  font-weight: 650;
}
.incomplete-guidance-head svg {
  flex: 0 0 auto;
  color: rgba(198, 176, 125, 0.82);
}
.incomplete-guidance-list {
  display: grid;
  gap: 7px;
  margin: 0;
  padding-left: 25px;
  color: rgba(232, 227, 217, 0.74);
  font-size: 13px;
  line-height: 1.55;
}
.incomplete-guidance-list li {
  padding-left: 3px;
  overflow-wrap: anywhere;
}
.incomplete-guidance-list strong {
  color: rgba(244, 241, 236, 0.92);
  font-weight: 700;
}
.incomplete-guidance-list li::marker {
  color: rgba(198, 176, 125, 0.78);
  font-weight: 700;
}

/* ── 补充需求 ── */
.more-input-wrap {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 2px 0;
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
  line-height: 1.4;
  outline: none;
}
.more-input-field:focus { border-color: var(--line-bright); }
.more-input-row .floor-btn {
  flex: 0 0 auto;
  min-height: 38px;
  margin-top: 0;
  padding-inline: 18px;
  white-space: nowrap;
}

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
.reset-error {
  padding: 9px 11px;
  border: 1px solid rgba(220, 139, 135, 0.34);
  border-radius: 6px;
  background: rgba(111, 55, 57, 0.14);
  color: #e7aaa6;
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
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
  .focus-welcome { margin-bottom: 16px; }
}

@media (max-width: 520px) {
  .chat-page.is-focus { padding: 96px 12px 32px; }
  .focus-welcome { gap: 10px; margin-bottom: 16px; }
  .focus-welcome h1 { font-size: 34px; }
  .composer-stage { height: 176px; flex-basis: 176px; }
  .composer { gap: 8px; }
  .composer-input-shell { padding: 14px 12px 10px; }
  .composer-input { font-size: 14px; }
  .composer-actions { gap: 4px; }
  .action-btn { width: 32px; padding: 0; }
  .send-btn { width: 36px; min-width: 36px; padding: 0; }
  .action-btn > span:not(.skill-toggle-badge),
  .send-btn > span { display: none; }
  .composer-mode { display: none; }
  .more-input-row { align-items: stretch; flex-direction: column; }
  .more-input-row .floor-btn { width: 100%; margin-top: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .qa-item,
  .live-spinner,
  .reset-overlay,
  .reset-modal { animation: none; }
  .welcome-collapse-enter-active,
  .welcome-collapse-leave-active { transition: none; }
}
</style>

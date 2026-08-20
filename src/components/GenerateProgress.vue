<template>
  <div class="gen-wrap" ref="wrapRef">
    <!-- 超级并发开关：默认逐阶段串行；开启后并行推进多个文件阶段 -->
    <div class="gen-super-bar" v-if="genTask.phase !== 'idle'">
      <button class="gen-super-toggle" :class="{ on: superConcurrency }"
              @click="setSuperConcurrency(!superConcurrency)">
        <span class="dot"></span>{{ superConcurrency ? "⚡ 超级并发 · 开" : "超级并发 · 关" }}
      </button>
      <span class="gen-super-note" :class="{ warn: superConcurrency }">
        {{ superConcurrency
          ? "并行推进多个文件阶段；中断时从已保存阶段继续"
          : "默认逐阶段串行，完成一个阶段就保存一次进度" }}
      </span>
      <button v-if="genTask.taskId" class="gen-super-toggle dbg" @click="downloadDebug"
              title="下载已脱敏的生成与联网学习诊断（JSON）">
        ⬇ 安全 Debug
      </button>
    </div>

    <!-- 规划卡片 -->
    <div class="glass2 gen-card" v-if="genTask.phase !== 'idle'">
      <div class="gen-card-head">
        <div class="gen-card-title">▪ 项目规划</div>
        <ThinkingMarquee v-if="marqueeOn" variant="compact"/>
      </div>
      <div class="gen-phases">
        <span v-for="p in phases" :key="p.key" class="gen-phase"
              :class="{active: p.key === genTask.phase, done: phaseOrder(p.key) < phaseOrder(genTask.phase)}">
          {{ p.label }}
        </span>
      </div>
      <div v-if="genTask.projectName" class="gen-info">
        <span class="tag">{{ genTask.projectName }}</span>
        <span class="tag">Java {{ genTask.javaVersion }}</span>
        <span class="tag">{{ genTask.packageName }}</span>
      </div>
      <section v-if="genTask.learningProgress.status !== 'idle'" class="learning-progress"
               :class="{
                 deferred: learningStopped,
                 ready: genTask.learningProgress.status === 'ready',
                 review: genTask.learningProgress.status === 'needs_review',
               }"
               aria-live="polite" aria-atomic="false">
        <div class="learning-head">
          <div class="learning-heading">
            <span class="learning-dot" :class="{ active: !learningTerminal }" aria-hidden="true"></span>
            <div class="learning-copy">
              <div class="learning-title">{{ learningTitle }}</div>
              <div class="learning-message">
                {{ genTask.learningProgress.message || learningStatusLabel }}
              </div>
            </div>
          </div>
          <div v-if="!learningTerminal" class="learning-time">
            <strong>{{ remainingTimeLabel }}</strong>
            <span>连续 5 分钟无有效进展后停止</span>
          </div>
          <div v-else class="learning-outcome">{{ learningOutcomeLabel }}</div>
        </div>

        <div v-if="!learningTerminal && genTask.learningProgress.currentNeed" class="learning-need">
          <span class="learning-need-label">当前查证</span>
          <span class="learning-need-text">{{ genTask.learningProgress.currentNeed }}</span>
        </div>

        <div class="learning-track" role="list" aria-label="联网查证阶段">
          <div v-for="(step, index) in learningSteps" :key="step" class="learning-track-step"
               :class="learningTrackState(index)" role="listitem">
            <span class="learning-track-marker" aria-hidden="true">{{ index + 1 }}</span>
            <span>{{ step }}</span>
          </div>
        </div>

        <div class="learning-metrics">
          <div class="learning-metric">
            <strong>{{ genTask.learningProgress.completedNeeds }}/{{ genTask.learningProgress.totalNeeds }}</strong>
            <span>技术缺口</span>
          </div>
          <div class="learning-metric">
            <strong>{{ genTask.learningProgress.searchedSourceCount }}</strong>
            <span>搜索 URL</span>
          </div>
          <div class="learning-metric">
            <strong>{{ genTask.learningProgress.sourceCount }}</strong>
            <span>有效证据</span>
          </div>
          <div class="learning-metric">
            <strong>{{ activeKnowledgeCount }}</strong>
            <span>已采用</span>
          </div>
          <div class="learning-metric">
            <strong>{{ reviewKnowledgeCount }}</strong>
            <span>待审核</span>
          </div>
        </div>

        <div v-if="learningStopped" class="learning-stop-note">
          本次查证已降级，不阻断后续生成
        </div>
      </section>
      <LearningEvidence :task-id="genTask.taskId" :knowledge-count="evidenceKnowledgeCount"
                        :searched-source-count="genTask.learningProgress.searchedSourceCount"
                        :learning-job-id="genTask.learningProgress.jobId"
                        :learning-stage="genTask.learningProgress.stage"
                        :learning-status="genTask.learningProgress.status"
                        :learning-revision="genTask.learningProgress.revision" />
    </div>

    <!-- 文件生成卡片：按生成器分组 -->
    <div class="glass2 gen-card" v-if="genTask.files.length">
      <div class="gen-card-title">▪ 代码生成</div>
      <div class="gen-groups">
        <div v-for="g in fileGroups" :key="g.type" class="gen-group">
          <div class="gen-group-header">
            <span class="gen-group-label">{{ generatorLabels[g.type] || g.type }}</span>
            <span class="gen-group-count">{{ g.files.length }}</span>
          </div>
          <div class="gen-group-files">
            <template v-for="f in g.files" :key="f.path">
              <div class="gen-file" :class="f.status" @click="toggleExpand(f.path)">
                <span class="gen-file-icon">
                  {{ f.status === "done" ? "●" : f.status === "generating" ? "◌" : f.status === "error" ? "×" : "○" }}
                </span>
                <span class="gen-file-path">{{ f.path }}</span>
                <span v-if="f.tag === 'gui'" class="gen-file-badge">GUI</span>
                <span v-if="f.streamingPhase" class="gen-file-phase">{{ streamPhaseLabels[f.streamingPhase] || f.streamingPhase }}</span>
                <span class="gen-file-role">{{ f.role }}</span>
              </div>
              <div v-if="f.status === 'generating' && f.streamingContent" class="gen-file-stream">
                <pre>{{ f.streamingContent }}</pre>
              </div>
            </template>
          </div>
        </div>
      </div>
      <div v-if="expandedFile?.content" class="gen-preview">
        <pre>{{ expandedFile.content }}</pre>
      </div>
    </div>

    <!-- AI 流式输出卡片 -->
    <div class="glass2 gen-card" v-if="genTask.streamingPhase">
      <div class="gen-card-title">{{ streamPhaseLabel }} {{ genTask.streamingFile }}</div>
      <div class="gen-stream-wrap" ref="streamRef">
        <pre class="gen-stream-text" :key="streamKey">{{ genTask.streamingContent }}</pre>
      </div>
    </div>

    <!-- 构建卡片 -->
    <div class="glass2 gen-card" v-if="showBuild">
      <div class="gen-card-title">▪ 构建</div>
      <div v-if="genTask.phase === 'building' || genTask.phase === 'uploading'" class="gen-building">
        <div class="gen-spinner"></div>
        <span>{{ genTask.phase === "uploading" ? "上传中..." : "构建中，请稍候..." }}</span>
      </div>
      <div v-if="genTask.phase === 'done'" class="gen-done">
        <a :href="downloadUrl" class="gen-download-btn">↓ 下载 JAR</a>
        <router-link :to="`/ide/${genTask.taskId}`" class="gen-download-btn ide">在 IDE 打开</router-link>
      </div>
    </div>

    <div class="glass2 gen-card gen-interrupted-card" v-if="genTask.phase === 'interrupted'">
      <div class="gen-card-title">▪ 任务已中断</div>
      <div class="gen-interrupted-copy">已保存当前进度，不会自动恢复或继续消耗 token。</div>
      <button class="gen-resume-btn" :disabled="resumeBusy" @click="continueGeneration">
        <Play :size="15" aria-hidden="true"/><span>继续任务</span>
      </button>
    </div>

    <!-- 失败卡片：手动重试入口（自动兜底用尽后，交回用户手动操作） -->
    <div class="glass2 gen-card gen-error-card" v-if="genTask.phase === 'error'">
      <div class="gen-card-title">▪ 生成失败</div>
      <div class="gen-error">{{ genTask.error }}</div>
      <div class="gen-error-actions">
        <button v-if="canRetry" class="gen-retry-btn" @click="retryGenerate">↻ 重试（用上次需求重跑）</button>
        <button v-if="genTask.taskId" class="gen-retry-btn ghost" @click="downloadDebug">⬇ 下载安全 Debug</button>
      </div>
    </div>

    <!-- 继续完善：生成完成后直接追加需求（增量补充现有项目）-->
    <div class="glass2 gen-card" v-if="genTask.phase === 'done'">
      <div class="gen-card-title">▪ 继续完善</div>
      <div class="gen-append">
        <textarea v-model="appendText" class="gen-append-input" rows="3"
                  placeholder="描述要追加 / 修改的功能，AI 将在当前项目上增量实现并重新编译（如：再加一条 /heal 命令）"
                  @compositionstart="onImeCompositionStart"
                  @compositionend="onImeCompositionEnd"
                  @keydown.enter.exact="onAppendEnter"></textarea>
        <div class="gen-append-foot">
          <span class="gen-append-hint">增量基于当前生成版本 · Enter 提交</span>
          <button class="gen-append-btn" :disabled="!appendText.trim()" @click="submitAppend">追加并重建</button>
        </div>
      </div>
    </div>

    <!-- 日志卡片 -->
    <div class="glass2 gen-card" v-if="genTask.logs.length">
      <div class="gen-card-title">▪ 日志</div>
      <div class="gen-logs" ref="logRef">
        <div v-for="(log, i) in genTask.logs" :key="i" class="gen-log">{{ log }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {ref, computed, watch, nextTick, onMounted, onBeforeUnmount} from "vue";
import {genTask, superConcurrency, setSuperConcurrency} from "../logic/generateState";
import type {GeneratorType, GenFile, LearningStatus} from "../logic/generateState";
import {getDownloadUrl, appendFeature, retryGenerate, canRetryGenerate, resumeGenerate} from "../logic/generateHandler";
import {isImeComposing, onImeCompositionEnd, onImeCompositionStart} from "../logic/keyboard";
import {buildSafeDebugExport} from "../logic/safeDebug";
import {Play} from "lucide-vue-next";
import ThinkingMarquee from "./ThinkingMarquee.vue";
import LearningEvidence from "./LearningEvidence.vue";

// 后台活跃阶段（无逐字流）显示跑马灯
const marqueeOn = computed(() =>
    ["planning", "generating", "verifying", "fixing"].includes(genTask.phase)
);
const canRetry = computed(() => canRetryGenerate() && genTask.phase === "error");
const resumeBusy = ref(false);

async function continueGeneration() {
    if (resumeBusy.value || genTask.phase !== "interrupted") return;
    resumeBusy.value = true;
    try {
        await resumeGenerate();
    } finally {
        resumeBusy.value = false;
    }
}
const activeKnowledgeCount = computed(() =>
    genTask.knowledgeUsed.filter(item => item.status === "active").length,
);
const reviewKnowledgeCount = computed(() =>
    genTask.knowledgeUsed.filter(item => item.status === "needs_review").length,
);
const evidenceKnowledgeCount = computed(() =>
    activeKnowledgeCount.value + reviewKnowledgeCount.value,
);

const learningSteps = ["准备", "发现", "抓取", "验证"] as const;
const learningTerminalStatuses = new Set<LearningStatus>([
    "ready", "deferred", "needs_review", "failed", "cancelled",
]);
const learningStatusLabels: Record<LearningStatus, string> = {
    idle: "等待联网查证",
    queued: "准备查证公开技术资料",
    discovering: "正在发现权威来源",
    fetching: "正在抓取并整理证据",
    verifying: "正在交叉验证技术结论",
    ready: "技术证据已准备完成",
    deferred: "已按现有知识继续",
    needs_review: "新结论正在等待审核",
    failed: "联网查证失败",
    cancelled: "联网查证已取消",
};
const learningNow = ref(Date.now());
let learningClock: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
    learningClock = setInterval(() => {
        learningNow.value = Date.now();
    }, 1_000);
});

onBeforeUnmount(() => {
    if (learningClock !== undefined) clearInterval(learningClock);
});

const learningTerminal = computed(() =>
    learningTerminalStatuses.has(genTask.learningProgress.status),
);
const learningStopped = computed(() =>
    genTask.learningDeferred
    || genTask.learningProgress.status === "deferred"
    || genTask.learningProgress.status === "failed"
    || genTask.learningProgress.status === "cancelled",
);
const learningTitle = computed(() => {
    if (genTask.learningProgress.stage === "tool") return "DS 主动联网查证";
    if (genTask.learningProgress.stage === "fix") return "修复前联网查证";
    if (genTask.learningProgress.stage === "planner") return "规划前联网查证";
    return "联网查证";
});
const learningStatusLabel = computed(() =>
    learningStatusLabels[genTask.learningProgress.status],
);
const learningOutcomeLabel = computed(() => {
    const status = genTask.learningProgress.status;
    if (status === "ready") return "查证完成";
    if (status === "needs_review") return "等待审核";
    if (status === "cancelled") return "已取消";
    if (status === "failed") return "查证失败";
    return "已继续生成";
});
const remainingTimeLabel = computed(() => {
    const deadlineAt = genTask.learningProgress.deadlineAt;
    if (!deadlineAt) return "剩余时间同步中";
    const seconds = Math.max(0, Math.ceil((deadlineAt - learningNow.value) / 1_000));
    const minutes = Math.floor(seconds / 60);
    return `剩余 ${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
});

function learningActiveStep(status: LearningStatus): number {
    if (status === "queued") return 0;
    if (status === "discovering") return 1;
    if (status === "fetching") return 2;
    if (status === "verifying") return 3;
    return -1;
}

function learningStoppedStep(): number {
    const progress = genTask.learningProgress;
    const lastActiveStep = progress.lastActiveStatus
        ? learningActiveStep(progress.lastActiveStatus)
        : -1;
    if (lastActiveStep >= 0) return lastActiveStep;
    const reason = progress.reasonCode || "";
    if (reason.startsWith("verification_")
        || reason === "unresolved_knowledge_needs"
        || reason === "planner_authorization_expired"
        || reason === "fix_authorization_expired") return 3;
    if (reason.startsWith("source_") || reason === "no_fetchable_sources") return 2;
    if (reason.startsWith("discovery_") || reason === "no_candidate_sources") return 1;
    if (progress.completedNeeds > 0 || progress.sourceCount > 0) return 3;
    if (progress.currentNeed) return 1;
    return 0;
}

function learningTrackState(index: number): "done" | "active" | "stopped" | "pending" {
    const status = genTask.learningProgress.status;
    if (status === "ready" || status === "needs_review") return "done";
    if (learningStopped.value) {
        const stoppedAt = learningStoppedStep();
        if (index < stoppedAt) return "done";
        return index === stoppedAt ? "stopped" : "pending";
    }
    const activeAt = learningActiveStep(status);
    if (index < activeAt) return "done";
    return index === activeAt ? "active" : "pending";
}

const expandedPath = ref<string>("");
const downloadUrl = computed(() => getDownloadUrl());

// 只下载正向白名单构造的诊断，避免源码、路径、Prompt 或上游响应进入文件。
function downloadDebug() {
    const payload = buildSafeDebugExport(genTask);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tahai-safe-debug-${payload.generation.taskId || "task"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// 继续完善：追加需求 → 增量补充
const appendText = ref("");
function submitAppend() {
    const t = appendText.value.trim();
    if (!t) return;
    appendText.value = "";
    appendFeature(t);
}

function onAppendEnter(event: KeyboardEvent) {
    if (isImeComposing(event)) return;
    event.preventDefault();
    submitAppend();
}

const generatorLabels: Record<GeneratorType, string> = {
    MainGen:        "主类",
    CommandGen:     "命令",
    ListenerGen:    "事件监听",
    TaskGen:        "调度任务",
    ManagerGen:     "数据/服务",
    ConfigClassGen: "配置类",
    ConfigGen:      "资源配置",
    ModelGen:       "数据模型",
    EnumGen:        "枚举",
    UtilGen:        "工具类",
    FileRelatedGen: "项目文件",
};

const groupOrder: GeneratorType[] = [
    "FileRelatedGen", "ConfigGen", "ConfigClassGen",
    "EnumGen", "ModelGen", "UtilGen",
    "ManagerGen", "TaskGen", "ListenerGen", "CommandGen",
    "MainGen",
];

const fileGroups = computed(() => {
    const buckets = new Map<GeneratorType, GenFile[]>();
    const fallback: GenFile[] = [];
    for (const f of genTask.files) {
        const t = f.generatorType;
        if (t && groupOrder.includes(t)) {
            if (!buckets.has(t)) buckets.set(t, []);
            buckets.get(t)!.push(f);
        } else {
            fallback.push(f);
        }
    }
    const ordered: { type: GeneratorType | "Other"; files: GenFile[] }[] = [];
    for (const t of groupOrder) {
        const fs = buckets.get(t);
        if (fs && fs.length) ordered.push({ type: t, files: fs });
    }
    if (fallback.length) ordered.push({ type: "Other" as any, files: fallback });
    return ordered;
});

const expandedFile = computed(() => genTask.files.find(f => f.path === expandedPath.value));
const wrapRef = ref<HTMLElement | null>(null);
const logRef = ref<HTMLElement | null>(null);
const streamRef = ref<HTMLElement | null>(null);

const streamPhaseLabels: Record<string, string> = {
    generating: "▸ 生成中",
    reviewing: "▸ 审查中",
    reworking: "▸ 修正中",
    summarizing: "▸ 提取摘要",
    fixing: "▸ 修复编译错误",
};
const streamPhaseLabel = computed(() => streamPhaseLabels[genTask.streamingPhase] || genTask.streamingPhase);
const streamKey = computed(() => genTask.streamingPhase + ":" + genTask.streamingFile);

const showBuild = computed(() =>
    ["uploading", "building", "polling", "fixing", "done"].includes(genTask.phase)
);

const phases = [
    {key: "planning", label: "规划"},
    {key: "generating", label: "生成"},
    {key: "verifying", label: "校验"},
    {key: "building", label: "构建"},
    {key: "done", label: "完成"},
];

const ORDER: Record<string, number> = {idle: 0, planning: 1, generating: 2, verifying: 3, uploading: 4, building: 4, polling: 4, fixing: 4, done: 5, error: -1};
function phaseOrder(key: string) { return ORDER[key] ?? 0; }
function toggleExpand(path: string) { expandedPath.value = expandedPath.value === path ? "" : path; }

watch(() => genTask.logs.length, async () => {
    await nextTick();
    logRef.value?.scrollTo({top: logRef.value.scrollHeight, behavior: "smooth"});
    wrapRef.value?.lastElementChild?.scrollIntoView({behavior: "smooth", block: "end"});
});

watch(() => genTask.phase, async () => {
    await nextTick();
    wrapRef.value?.lastElementChild?.scrollIntoView({behavior: "smooth", block: "end"});
});

watch(() => genTask.streamingContent, async () => {
    await nextTick();
    if (streamRef.value) streamRef.value.scrollTop = streamRef.value.scrollHeight;
});
</script>

<style scoped>
.gen-wrap {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 超级并发开关 */
.gen-super-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 2px 2px 0;
}
.gen-super-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 600;
  color: rgba(209, 200, 182, 0.62);
  background: rgba(209, 200, 182, 0.045);
  border: 1px solid rgba(209, 200, 182, 0.16);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.18s;
  white-space: nowrap;
}
.gen-super-toggle:hover { color: #f4f1ec; border-color: rgba(209, 200, 182, 0.38); }
.gen-super-toggle .dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: rgba(209, 200, 182, 0.3);
  transition: all 0.18s;
}
.gen-super-toggle.on {
  color: #d5c9ac;
  background: rgba(198, 176, 125, 0.09);
  border-color: rgba(198, 176, 125, 0.5);
}
.gen-super-toggle.on .dot { background: #c6b07d; box-shadow: 0 0 8px rgba(198, 176, 125, 0.5); }
.gen-super-note {
  font-size: 11.5px;
  color: rgba(209, 200, 182, 0.4);
}
.gen-super-note.warn { color: rgba(198, 176, 125, 0.85); }
.gen-super-toggle.dbg {
  margin-left: auto;
  color: rgba(67, 128, 145, 0.9);
  border-color: rgba(67, 128, 145, 0.38);
  background: rgba(67, 128, 145, 0.08);
}
.gen-super-toggle.dbg:hover { color: #7ca9b5; border-color: rgba(67, 128, 145, 0.62); }
.dbg-count {
  font-size: 10px;
  opacity: 0.7;
  padding: 1px 5px;
  border-radius: 4px; /* 圆角矩形 */
  background: rgba(67, 128, 145, 0.16);
}

/* 规划卡头部：标题 + 跑马灯并排 */
.gen-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

/* 失败卡片 + 重试 */
.gen-card.gen-interrupted-card {
  border-color: rgba(198, 176, 125, 0.48);
  box-shadow: inset 3px 0 0 rgba(198, 176, 125, 0.74), 0 12px 32px rgba(0,0,0,0.2);
}
.gen-interrupted-copy {
  color: rgba(232, 227, 217, 0.68);
  font-size: 13px;
  line-height: 1.55;
}
.gen-resume-btn {
  align-self: flex-start;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 8px 16px;
  border: 1px solid rgba(198, 176, 125, 0.48);
  border-radius: 6px;
  background: rgba(198, 176, 125, 0.1);
  color: #e6d9ba;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}
.gen-resume-btn:hover:not(:disabled) {
  border-color: rgba(213, 201, 172, 0.74);
  background: rgba(198, 176, 125, 0.17);
  color: #fff7e5;
}
.gen-resume-btn:focus-visible {
  outline: 2px solid rgba(213, 201, 172, 0.72);
  outline-offset: 2px;
}
.gen-resume-btn:disabled { opacity: 0.42; cursor: not-allowed; }
.gen-card.gen-error-card {
  border-color: rgba(255, 122, 102, 0.55);
  box-shadow: inset 3px 0 0 rgba(255, 122, 102, 0.72), 0 12px 32px rgba(0,0,0,0.2);
}
.gen-error-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.gen-retry-btn {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  color: #ffd9a0;
  background: rgba(255, 176, 46, 0.12);
  border: 1px solid rgba(255, 176, 46, 0.45);
  border-radius: 8px; /* 圆角矩形 */
  cursor: pointer;
  transition: all 0.18s;
}
.gen-retry-btn:hover { background: rgba(255, 176, 46, 0.2); border-color: rgba(255, 176, 46, 0.7); }
.gen-retry-btn.ghost {
  color: rgba(120, 200, 255, 0.85);
  background: rgba(120, 200, 255, 0.08);
  border-color: rgba(120, 200, 255, 0.3);
}
.gen-retry-btn.ghost:hover { background: rgba(120, 200, 255, 0.16); border-color: rgba(120, 200, 255, 0.55); }

.gen-card {
  flex-direction: column;
  gap: 12px;
  height: auto;
  border-radius: 8px;
  background: rgba(4, 4, 2, 0.88);
  border: 1px solid rgba(209, 200, 182, 0.16);
  box-shadow: inset 0 1px 0 rgba(244, 241, 236, 0.04), 0 16px 42px rgba(0,0,0,0.26);
}
.gen-card-title {
  font-size: 14px;
  color: var(--text-secondary, #abb6ba);
  user-select: none;
}

.gen-phases {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.gen-phase {
  padding: 4px 16px;
  border-radius: 4px;
  font-size: 13px;
  border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.3);
  transition: all 0.3s;
}
.gen-phase.active {
  background: #d5c9ac;
  color: #040402;
  border-color: #e1d8c4;
}
.gen-phase.done {
  background: rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.6);
  border-color: rgba(255,255,255,0.15);
}

.gen-info {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.learning-progress {
  min-height: 76px;
  display: grid;
  gap: 13px;
  padding: 14px 16px 13px;
  border-left: 3px solid rgba(67, 128, 145, 0.82);
  background: rgba(67, 128, 145, 0.085);
  color: rgba(220, 233, 236, 0.82);
}
.learning-progress.deferred {
  border-left-color: rgba(198, 176, 125, 0.82);
  background: rgba(198, 176, 125, 0.075);
  color: rgba(232, 217, 183, 0.82);
}
.learning-progress.ready {
  border-left-color: rgba(93, 159, 118, 0.86);
  background: rgba(93, 159, 118, 0.07);
}
.learning-progress.review {
  border-left-color: rgba(180, 143, 68, 0.86);
  background: rgba(180, 143, 68, 0.075);
}
.learning-head {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.learning-heading {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.learning-copy { min-width: 0; }
.learning-title {
  color: rgba(244, 241, 236, 0.94);
  font-size: 15px;
  font-weight: 650;
  line-height: 1.35;
}
.learning-message {
  margin-top: 3px;
  color: currentColor;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.learning-dot {
  width: 9px;
  height: 9px;
  flex: 0 0 9px;
  margin-top: 5px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 8px currentColor;
}
.learning-dot.active { animation: learning-pulse 1.8s ease-in-out infinite; }
@keyframes learning-pulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}
.learning-time {
  flex: 0 0 auto;
  display: grid;
  justify-items: end;
  gap: 2px;
  padding-left: 14px;
  border-left: 1px solid rgba(244, 241, 236, 0.12);
}
.learning-time strong {
  color: rgba(244, 241, 236, 0.88);
  font: 600 13px/1.35 monospace;
}
.learning-time span {
  color: rgba(244, 241, 236, 0.38);
  font-size: 11px;
}
.learning-outcome {
  flex: 0 0 auto;
  color: rgba(244, 241, 236, 0.66);
  font-size: 12px;
  font-weight: 600;
}
.learning-need {
  min-width: 0;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(244, 241, 236, 0.1);
}
.learning-need-label {
  color: rgba(244, 241, 236, 0.42);
  font-size: 11px;
  font-weight: 600;
}
.learning-need-text {
  color: rgba(244, 241, 236, 0.76);
  font-size: 12.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.learning-track {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.learning-track-step {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding-top: 8px;
  border-top: 2px solid rgba(244, 241, 236, 0.12);
  color: rgba(244, 241, 236, 0.32);
  font-size: 11px;
}
.learning-track-step.done {
  border-top-color: rgba(93, 159, 118, 0.72);
  color: rgba(169, 216, 186, 0.76);
}
.learning-track-step.active {
  border-top-color: rgba(92, 157, 174, 0.9);
  color: rgba(183, 219, 227, 0.92);
}
.learning-track-step.stopped {
  border-top-color: rgba(198, 176, 125, 0.78);
  color: rgba(226, 210, 173, 0.82);
}
.learning-track-marker {
  width: 19px;
  height: 19px;
  flex: 0 0 19px;
  display: grid;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
  font: 10px/1 monospace;
}
.learning-metrics {
  display: grid;
  grid-template-columns: repeat(5, minmax(72px, 1fr));
  padding-top: 10px;
  border-top: 1px solid rgba(244, 241, 236, 0.1);
}
.learning-metric {
  min-width: 0;
  display: grid;
  gap: 2px;
  padding: 0 12px;
  border-left: 1px solid rgba(244, 241, 236, 0.09);
}
.learning-metric:first-child {
  padding-left: 0;
  border-left: 0;
}
.learning-metric strong {
  color: rgba(244, 241, 236, 0.9);
  font: 600 14px/1.3 monospace;
}
.learning-metric span {
  color: rgba(244, 241, 236, 0.4);
  font-size: 11px;
}
.learning-stop-note {
  padding-top: 9px;
  border-top: 1px dashed rgba(244, 241, 236, 0.12);
  color: rgba(232, 217, 183, 0.7);
  font-size: 12px;
  line-height: 1.5;
}
.tag {
  padding: 3px 14px;
  border-radius: 4px;
  font-size: 13px;
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.7);
}

.gen-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* 直接铺开，不做内部滚动 */
}
.gen-group {
  border: 1px solid rgba(209, 200, 182, 0.14);
  border-radius: 4px;
  padding: 8px 10px 6px;
  background: #090907;
}
.gen-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px 6px;
  border-bottom: 1px dashed rgba(255,255,255,0.08);
  margin-bottom: 4px;
}
.gen-group-label {
  font-size: 12px;
  color: rgba(255,255,255,0.55);
  letter-spacing: 0;
}
.gen-group-count {
  font-size: 11px;
  color: rgba(255,255,255,0.3);
  margin-left: auto;
  font-family: monospace;
}
.gen-group-files {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gen-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
  font-size: 13px;
}
.gen-file:hover { background: rgba(255,255,255,0.04); }
.gen-file.done { color: rgba(255,255,255,0.8); }
.gen-file.generating { color: var(--oak-highlight, #AF9876); }
.gen-file.pending { color: rgba(255,255,255,0.3); }
.gen-file-icon { flex: 0 0 20px; }
.gen-file-path { color: inherit; font-family: monospace; }
.gen-file-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.7);
  letter-spacing: 0;
  font-family: monospace;
}
.gen-file-phase {
  font-size: 11px;
  color: var(--oak-highlight, #AF9876);
  font-family: monospace;
  margin-left: 4px;
}
.gen-file-role { margin-left: auto; color: rgba(255,255,255,0.3); font-size: 12px; }
.gen-file-stream {
  margin: 0 0 6px 28px;
  background: rgba(0,0,0,0.25);
  border-radius: 6px;
  padding: 8px 10px;
  max-height: 120px;
  overflow-y: auto;
}
.gen-file-stream pre {
  color: rgba(255,255,255,0.7);
  font-family: "Monaco", monospace;
  font-size: 10px;
  line-height: 1.4;
  white-space: pre-wrap;
  margin: 0;
}

.gen-preview {
  background: rgba(0,0,0,0.3);
  border-radius: 10px;
  padding: 14px;
  max-height: 300px;
  overflow: auto;
}
.gen-preview pre {
  color: rgba(255,255,255,0.8);
  font-size: 12px;
  font-family: "Consolas", "Fira Code", monospace;
  white-space: pre-wrap;
  margin: 0;
}

.gen-building {
  display: flex;
  align-items: center;
  gap: 12px;
  color: rgba(255,255,255,0.6);
  font-size: 14px;
}
.gen-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255,255,255,0.15);
  border-top-color: var(--oak-highlight, #AF9876);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.gen-done {
  text-align: center;
  display: flex;
  gap: 12px;
  justify-content: center;
}
.gen-download-btn {
  display: inline-block;
  padding: 12px 36px;
  border-radius: 4px;
  background: #d5c9ac;
  color: #040402;
  font-size: 16px;
  text-decoration: none;
  font-weight: 500;
  transition: opacity 0.2s;
}
.gen-download-btn:hover { opacity: 0.85; }
.gen-download-btn.ide {
  background: rgba(255,255,255,0.08);
  color: var(--oak-highlight, #AF9876);
  border: 1px solid rgba(134,112,83,0.55);
}

.gen-error {
  color: #ff9a8b;
  font-size: 14px;
}

.gen-append {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.gen-append-input {
  width: 100%;
  resize: none;
  background: #090907;
  border: 1px solid rgba(209, 200, 182, 0.18);
  border-radius: 4px;
  padding: 10px 12px;
  color: #f4f1ec;
  font-size: 14px;
  line-height: 1.5;
  outline: none;
  font-family: inherit;
  transition: border-color 0.2s;
}
.gen-append-input:focus { border-color: var(--oak-highlight, #AF9876); }
.gen-append-input::placeholder { color: rgba(255, 255, 255, 0.3); }
.gen-append-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.gen-append-hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.35);
}
.gen-append-btn {
  flex-shrink: 0;
  padding: 8px 20px;
  border-radius: 4px;
  border: 1px solid #e1d8c4;
  background: #d5c9ac;
  color: #040402;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s;
}
.gen-append-btn:hover:not(:disabled) { opacity: 0.85; }
.gen-append-btn:disabled { opacity: 0.35; cursor: not-allowed; }

.gen-logs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
  overflow-y: auto;
  scroll-behavior: smooth;
}
.gen-log {
  font-size: 12px;
  color: rgba(255,255,255,0.35);
  font-family: monospace;
}

.gen-stream-wrap {
  max-height: 250px;
  overflow-y: auto;
  background: rgba(0,0,0,0.3);
  border-radius: 10px;
  padding: 12px;
}
.gen-stream-text {
  color: rgba(255,255,255,0.8);
  font-family: "Monaco", monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  margin: 0;
  animation: blurFadeIn 0.4s ease-out;
}
@keyframes blurFadeIn {
  from { opacity: 0; filter: blur(4px); }
  to   { opacity: 1; filter: blur(0); }
}

@media (max-width: 640px) {
  .learning-progress { padding: 13px 12px; }
  .learning-head { align-items: stretch; flex-direction: column; gap: 10px; }
  .learning-time {
    justify-items: start;
    padding: 8px 0 0;
    border-top: 1px solid rgba(244, 241, 236, 0.1);
    border-left: 0;
  }
  .learning-need { grid-template-columns: 1fr; gap: 4px; }
  .learning-track { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 8px; }
  .learning-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 12px; }
  .learning-metric { padding: 0 10px; }
  .learning-metric:nth-child(3),
  .learning-metric:nth-child(5) {
    padding-left: 0;
    border-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .learning-dot.active,
  .gen-spinner,
  .gen-stream-text { animation: none; }
}
</style>

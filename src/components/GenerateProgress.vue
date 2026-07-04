<template>
  <div class="gen-wrap" ref="wrapRef">
    <!-- 超级并发开关：默认串行最稳；开启桶内并发更快但更易生成失败，慎用 -->
    <div class="gen-super-bar" v-if="genTask.phase !== 'idle'">
      <button class="gen-super-toggle" :class="{ on: superConcurrency }"
              @click="setSuperConcurrency(!superConcurrency)">
        <span class="dot"></span>{{ superConcurrency ? "⚡ 超级并发 · 开" : "超级并发 · 关" }}
      </button>
      <span class="gen-super-note" :class="{ warn: superConcurrency }">
        {{ superConcurrency
          ? "⚠ 桶内并发更快，但更易撞 Cloudflare 限制导致生成失败，慎用"
          : "默认串行最稳。开启后更快，但可能失败" }}
      </span>
      <button v-if="genTask.debugLog.length" class="gen-super-toggle dbg" @click="downloadDebug"
              title="导出后端逐步调试日志（JSON），用于定位生成失败">
        ⬇ 调试日志 <span class="dbg-count">{{ genTask.debugLog.length }}</span>
      </button>
    </div>

    <!-- 规划卡片 -->
    <div class="glass2 gen-card" v-if="genTask.phase !== 'idle'">
      <div class="gen-card-head">
        <div class="gen-card-title">▪ 项目规划</div>
        <ThinkingMarquee v-if="marqueeOn"/>
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

    <!-- 失败卡片：手动重试入口（自动兜底用尽后，交回用户手动操作） -->
    <div class="glass2 gen-card gen-error-card" v-if="genTask.phase === 'error'">
      <div class="gen-card-title">▪ 生成失败</div>
      <div class="gen-error">{{ genTask.error }}</div>
      <div class="gen-error-actions">
        <button v-if="canRetry" class="gen-retry-btn" @click="retryGenerate">↻ 重试（用上次需求重跑）</button>
        <button v-if="genTask.debugLog.length" class="gen-retry-btn ghost" @click="downloadDebug">⬇ 下载调试日志</button>
      </div>
    </div>

    <!-- 继续完善：生成完成后直接追加需求（增量补充现有项目）-->
    <div class="glass2 gen-card" v-if="genTask.phase === 'done'">
      <div class="gen-card-title">▪ 继续完善</div>
      <div class="gen-append">
        <textarea v-model="appendText" class="gen-append-input" rows="3"
                  placeholder="描述要追加 / 修改的功能，AI 将在当前项目上增量实现并重新编译（如：再加一条 /heal 命令）"
                  @keydown.enter.exact.prevent="submitAppend"></textarea>
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
import {ref, computed, watch, nextTick} from "vue";
import {genTask, superConcurrency, setSuperConcurrency} from "../logic/generateState";
import type {GeneratorType, GenFile} from "../logic/generateState";
import {getDownloadUrl, appendFeature, retryGenerate, canRetryGenerate} from "../logic/generateHandler";
import ThinkingMarquee from "./ThinkingMarquee.vue";

// 后台活跃阶段（无逐字流）显示跑马灯
const marqueeOn = computed(() =>
    ["planning", "generating", "verifying", "fixing"].includes(genTask.phase)
);
const canRetry = computed(() => canRetryGenerate() && genTask.phase === "error");

const expandedPath = ref<string>("");
const downloadUrl = computed(() => getDownloadUrl());

// 导出后端逐步调试日志（含 logs + debug 事件），用于定位「桶零进度、无返回」死因
function downloadDebug() {
    const payload = {
        taskId: genTask.taskId,
        phase: genTask.phase,
        error: genTask.error,
        projectName: genTask.projectName,
        exportedAt: new Date().toISOString(),
        logs: genTask.logs,
        debug: genTask.debugLog,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tahai-debug-${genTask.taskId || "task"}.json`;
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
  color: rgba(255, 255, 255, 0.6);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px; /* 圆角矩形 */
  cursor: pointer;
  transition: all 0.18s;
  white-space: nowrap;
}
.gen-super-toggle:hover { color: rgba(255, 255, 255, 0.85); border-color: rgba(255, 255, 255, 0.25); }
.gen-super-toggle .dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
  transition: all 0.18s;
}
.gen-super-toggle.on {
  color: #ffcf6b;
  background: rgba(255, 176, 46, 0.12);
  border-color: rgba(255, 176, 46, 0.5);
}
.gen-super-toggle.on .dot { background: #ffb02e; box-shadow: 0 0 8px #ffb02e; }
.gen-super-note {
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.4);
}
.gen-super-note.warn { color: rgba(255, 176, 46, 0.85); }
.gen-super-toggle.dbg {
  margin-left: auto;
  color: rgba(120, 200, 255, 0.85);
  border-color: rgba(120, 200, 255, 0.3);
  background: rgba(120, 200, 255, 0.08);
}
.gen-super-toggle.dbg:hover { color: #9dd4ff; border-color: rgba(120, 200, 255, 0.55); }
.dbg-count {
  font-size: 10px;
  opacity: 0.7;
  padding: 1px 5px;
  border-radius: 4px; /* 圆角矩形 */
  background: rgba(120, 200, 255, 0.15);
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
.gen-error-card { border-color: rgba(255, 122, 102, 0.35); }
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
}
.gen-card-title {
  font-size: 14px;
  color: rgba(255,255,255,0.5);
  user-select: none;
}

.gen-phases {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.gen-phase {
  padding: 4px 16px;
  border-radius: 10px;
  font-size: 13px;
  border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.3);
  transition: all 0.3s;
}
.gen-phase.active {
  background: wheat;
  color: #000;
  border-color: wheat;
}
.gen-phase.done {
  background: rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.6);
  border-color: rgba(255,255,255,0.15);
}

.gen-info {
  display: flex;
  gap: 8px;
}
.tag {
  padding: 3px 14px;
  border-radius: 8px;
  font-size: 13px;
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.7);
}

.gen-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 480px;
  overflow-y: auto;
}
.gen-group {
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  padding: 8px 10px 6px;
  background: rgba(255,255,255,0.015);
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
  letter-spacing: 0.4px;
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
.gen-file.generating { color: wheat; }
.gen-file.pending { color: rgba(255,255,255,0.3); }
.gen-file-icon { flex: 0 0 20px; }
.gen-file-path { color: inherit; font-family: monospace; }
.gen-file-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.7);
  letter-spacing: 0.5px;
  font-family: monospace;
}
.gen-file-phase {
  font-size: 11px;
  color: wheat;
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
  border-top-color: wheat;
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
  border-radius: 12px;
  background: wheat;
  color: #000;
  font-size: 16px;
  text-decoration: none;
  font-weight: 500;
  transition: opacity 0.2s;
}
.gen-download-btn:hover { opacity: 0.85; }
.gen-download-btn.ide {
  background: rgba(255,255,255,0.08);
  color: wheat;
  border: 1px solid rgba(245,222,179,0.3);
}

.gen-error {
  color: #999;
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
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(245, 222, 179, 0.18);
  border-radius: 10px;
  padding: 10px 12px;
  color: #f3e7d4;
  font-size: 14px;
  line-height: 1.5;
  outline: none;
  font-family: inherit;
  transition: border-color 0.2s;
}
.gen-append-input:focus { border-color: rgba(245, 222, 179, 0.5); }
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
  border-radius: 10px;
  border: none;
  background: wheat;
  color: #1c1812;
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
</style>

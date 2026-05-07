<template>
  <div class="gen-wrap" ref="wrapRef">
    <!-- 规划卡片 -->
    <div class="glass2 gen-card" v-if="genTask.phase !== 'idle'">
      <div class="gen-card-title">▪ 项目规划</div>
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
      </div>
      <div v-if="genTask.phase === 'error'" class="gen-error">{{ genTask.error }}</div>
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
import {genTask} from "../logic/generateState";
import type {GeneratorType, GenFile} from "../logic/generateState";
import {getDownloadUrl} from "../logic/generateHandler";

const expandedPath = ref<string>("");
const downloadUrl = computed(() => getDownloadUrl());

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
    ["uploading", "building", "polling", "fixing", "done", "error"].includes(genTask.phase)
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

.gen-done { text-align: center; }
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

.gen-error {
  color: #999;
  font-size: 14px;
}

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

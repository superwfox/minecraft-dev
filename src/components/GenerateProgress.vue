<template>
  <div class="gen-wrap" ref="wrapRef">
    <!-- 规划卡片 -->
    <div class="glass2 gen-card" v-if="genTask.phase !== 'idle'">
      <div class="gen-card-title">📋 项目规划</div>
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

    <!-- 文件生成卡片 -->
    <div class="glass2 gen-card" v-if="genTask.files.length">
      <div class="gen-card-title">📝 代码生成</div>
      <div class="gen-files">
        <div v-for="(f, i) in genTask.files" :key="f.path" class="gen-file"
             :class="f.status" @click="toggleExpand(i)">
          <span class="gen-file-icon">
            {{ f.status === "done" ? "✅" : f.status === "generating" ? "🔄" : "⏳" }}
          </span>
          <span class="gen-file-path">{{ f.path }}</span>
          <span class="gen-file-role">{{ f.role }}</span>
        </div>
      </div>
      <div v-if="expandedIndex >= 0 && genTask.files[expandedIndex]?.content" class="gen-preview">
        <pre>{{ genTask.files[expandedIndex].content }}</pre>
      </div>
    </div>

    <!-- 构建卡片 -->
    <div class="glass2 gen-card" v-if="showBuild">
      <div class="gen-card-title">🔨 构建</div>
      <div v-if="genTask.phase === 'building' || genTask.phase === 'uploading'" class="gen-building">
        <div class="gen-spinner"></div>
        <span>{{ genTask.phase === "uploading" ? "上传中..." : "构建中，请稍候..." }}</span>
      </div>
      <div v-if="genTask.phase === 'done'" class="gen-done">
        <a :href="downloadUrl" class="gen-download-btn">📦 下载 JAR</a>
      </div>
      <div v-if="genTask.phase === 'error'" class="gen-error">{{ genTask.error }}</div>
    </div>

    <!-- 日志卡片 -->
    <div class="glass2 gen-card" v-if="genTask.logs.length">
      <div class="gen-card-title">📜 日志</div>
      <div class="gen-logs" ref="logRef">
        <div v-for="(log, i) in genTask.logs" :key="i" class="gen-log">{{ log }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {ref, computed, watch, nextTick} from "vue";
import {genTask} from "../logic/generateState";
import {getDownloadUrl} from "../logic/generateHandler";

const expandedIndex = ref(-1);
const downloadUrl = computed(() => getDownloadUrl());
const wrapRef = ref<HTMLElement | null>(null);
const logRef = ref<HTMLElement | null>(null);

const showBuild = computed(() =>
    ["uploading", "building", "polling", "done", "error"].includes(genTask.phase)
);

const phases = [
    {key: "planning", label: "规划"},
    {key: "generating", label: "生成"},
    {key: "verifying", label: "校验"},
    {key: "building", label: "构建"},
    {key: "done", label: "完成"},
];

const ORDER: Record<string, number> = {idle: 0, planning: 1, generating: 2, verifying: 3, uploading: 4, building: 4, polling: 4, done: 5, error: -1};
function phaseOrder(key: string) { return ORDER[key] ?? 0; }
function toggleExpand(i: number) { expandedIndex.value = expandedIndex.value === i ? -1 : i; }

watch(() => genTask.logs.length, async () => {
    await nextTick();
    logRef.value?.scrollTo({top: logRef.value.scrollHeight, behavior: "smooth"});
    wrapRef.value?.lastElementChild?.scrollIntoView({behavior: "smooth", block: "end"});
});

watch(() => genTask.phase, async () => {
    await nextTick();
    wrapRef.value?.lastElementChild?.scrollIntoView({behavior: "smooth", block: "end"});
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

.gen-files {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 300px;
  overflow-y: auto;
}
.gen-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
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
.gen-file-role { margin-left: auto; color: rgba(255,255,255,0.3); font-size: 12px; }

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
</style>

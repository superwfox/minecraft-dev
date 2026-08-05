<template>
  <section v-if="taskId && (knowledgeCount > 0 || statusVisible)" class="learning-evidence">
    <button class="learning-toggle" type="button" @click="toggle"
            :aria-expanded="expanded" :aria-controls="bodyId">
      <BookOpenCheck :size="17" aria-hidden="true" />
      <span>本次依据</span>
      <span v-if="knowledgeCount" class="learning-count">{{ knowledgeCount }}</span>
      <ChevronDown :size="17" class="learning-chevron" :class="{ open: expanded }" aria-hidden="true" />
    </button>

    <div v-if="expanded" :id="bodyId" class="learning-body">
      <div v-if="loading" class="learning-empty">
        <LoaderCircle :size="17" class="spin" aria-hidden="true" />
        <span>正在读取证据</span>
      </div>
      <div v-else-if="error" class="learning-empty error">
        <span>{{ error }}</span>
        <button type="button" class="retry" title="重新加载" @click="load">
          <RefreshCw :size="16" aria-hidden="true" />
        </button>
      </div>
      <div v-else-if="!items.length" class="learning-empty">本次没有采用新的联网结论</div>

      <div v-else class="learning-items">
        <article v-for="item in items" :key="item.knowledgeId" class="learning-item">
          <div class="learning-item-head">
            <span class="learning-status" :class="item.status">{{ statusLabel(item.status) }}</span>
            <span class="learning-confidence">{{ Math.round(item.confidence * 100) }}%</span>
          </div>
          <div class="learning-summary">{{ item.summary }}</div>
          <div v-if="item.scope" class="learning-scope">{{ formatScope(item.scope) }}</div>
          <div v-if="item.sources?.length" class="learning-sources">
            <a v-for="source in item.sources" :key="source.sourceId"
               class="learning-source" :href="source.url" target="_blank" rel="noopener noreferrer">
              <span class="source-main">
                <span class="source-title">{{ source.title }}</span>
                <span class="source-meta">{{ source.authority }} · {{ source.sourceType }} · {{ formatDate(source.publishedAt || source.fetchedAt) }}</span>
              </span>
              <ExternalLink :size="15" class="source-link-icon" aria-hidden="true" />
            </a>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { BookOpenCheck, ChevronDown, ExternalLink, LoaderCircle, RefreshCw } from "lucide-vue-next";
import {
    isLearningEvidenceTerminalStatus,
    resolveLearningEvidenceResult,
    type LearningEvidenceIdentity,
} from "../logic/learningEvidenceState";

const props = defineProps<{
    taskId: string;
    knowledgeCount: number;
    learningJobId?: string;
    learningStage?: string;
    learningStatus?: string;
    learningRevision?: number;
}>();

const expanded = ref(false);
const loading = ref(false);
const error = ref("");
const items = ref<any[]>([]);
const loadedKey = ref("");
let loadSequence = 0;

const statusVisible = computed(() => !!props.learningStatus && props.learningStatus !== "idle");
const bodyId = computed(() => {
    const suffix = props.taskId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100) || "current";
    return `learning-evidence-body-${suffix}`;
});
const evidenceIdentity = computed<LearningEvidenceIdentity>(() => {
    const jobId = typeof props.learningJobId === "string"
        && /^[A-Za-z0-9_-]{1,100}$/.test(props.learningJobId)
        ? props.learningJobId
        : "";
    const stage = jobId && (props.learningStage === "planner" || props.learningStage === "fix")
        ? props.learningStage
        : "";
    const revision = jobId && Number.isInteger(Number(props.learningRevision))
        ? Math.max(0, Number(props.learningRevision))
        : 0;
    return { jobId, stage, revision };
});
const evidenceKey = computed(() => {
    const identity = evidenceIdentity.value;
    const terminalStatus = isLearningEvidenceTerminalStatus(props.learningStatus)
        ? props.learningStatus
        : "active";
    return [
        props.taskId,
        identity.jobId,
        identity.stage,
        identity.revision,
        Math.max(0, props.knowledgeCount),
        terminalStatus,
    ].join(":");
});

function statusLabel(status: string) {
    if (status === "active") return "已采用";
    if (status === "needs_review") return "待审核";
    if (status === "rejected") return "已驳回";
    return "未采用";
}

function formatDate(ts?: number) {
    if (!ts) return "日期未知";
    try { return new Date(ts).toLocaleDateString("zh-CN"); } catch { return "日期未知"; }
}

function formatScope(raw: unknown) {
    if (!raw) return "";
    if (typeof raw === "string") {
        try { return formatScope(JSON.parse(raw)); } catch { return raw; }
    }
    if (typeof raw !== "object") return String(raw);
    return Object.entries(raw as Record<string, unknown>)
        .filter(([, value]) => value != null && value !== "")
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(" · ");
}

async function load() {
    if (!props.taskId) return;
    const sequence = ++loadSequence;
    const requestedKey = evidenceKey.value;
    const requestedIdentity = { ...evidenceIdentity.value };
    loading.value = true;
    error.value = "";
    try {
        const params = new URLSearchParams({ taskId: props.taskId });
        if (requestedIdentity.jobId && requestedIdentity.stage) {
            params.set("jobId", requestedIdentity.jobId);
            params.set("stage", requestedIdentity.stage);
            params.set("revision", String(requestedIdentity.revision));
        }
        const resp = await fetch(`/api/learning/evidence?${params.toString()}`);
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json();
        if (sequence !== loadSequence) return;
        const responseIdentity: LearningEvidenceIdentity = {
            jobId: typeof data.learningJobId === "string" ? data.learningJobId : "",
            stage: data.learningStage === "planner" || data.learningStage === "fix"
                ? data.learningStage
                : "",
            revision: Number.isInteger(Number(data.learningRevision))
                ? Math.max(0, Number(data.learningRevision))
                : 0,
        };
        const result = resolveLearningEvidenceResult(
            data.items,
            data.learningStatus,
            requestedIdentity,
            responseIdentity,
        );
        items.value = result.items;
        loadedKey.value = result.cache ? requestedKey : "";
        if (!result.identityMatches) return;
    } catch {
        if (sequence !== loadSequence) return;
        error.value = "证据暂时无法读取";
    } finally {
        if (sequence === loadSequence) loading.value = false;
    }
}

function toggle() {
    expanded.value = !expanded.value;
    if (expanded.value && loadedKey.value !== evidenceKey.value) void load();
}

watch(() => props.taskId, () => {
    loadSequence++;
    expanded.value = false;
    loading.value = false;
    loadedKey.value = "";
    items.value = [];
    error.value = "";
});

watch(evidenceKey, (next, previous) => {
    if (expanded.value && next !== previous) void load();
});
</script>

<style scoped>
.learning-evidence {
  border-top: 1px solid rgba(209, 200, 182, 0.12);
  padding-top: 10px;
}
.learning-toggle {
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 2px;
  color: rgba(244, 241, 236, 0.76);
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  text-align: left;
}
.learning-toggle:hover { color: #f4f1ec; }
.learning-count {
  min-width: 22px;
  padding: 2px 7px;
  border-radius: 4px;
  background: rgba(67, 128, 145, 0.16);
  color: #8db4be;
  text-align: center;
  font-family: monospace;
  font-size: 11px;
}
.learning-chevron { margin-left: auto; transition: transform 0.18s; }
.learning-chevron.open { transform: rotate(180deg); }
.learning-body { padding: 8px 0 0; }
.learning-empty {
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 9px;
  color: rgba(244, 241, 236, 0.46);
  font-size: 13px;
}
.learning-empty.error { color: #e6a394; }
.retry {
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  color: inherit;
  background: transparent;
  border: 1px solid rgba(244, 241, 236, 0.16);
  border-radius: 4px;
  cursor: pointer;
}
.learning-items { display: flex; flex-direction: column; }
.learning-item {
  padding: 12px 2px;
  border-top: 1px solid rgba(244, 241, 236, 0.08);
}
.learning-item:first-child { border-top: 0; }
.learning-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 7px;
}
.learning-status {
  padding: 2px 7px;
  border-radius: 4px;
  color: rgba(244, 241, 236, 0.58);
  background: rgba(244, 241, 236, 0.08);
  font-size: 11px;
}
.learning-status.active { color: #a9d8ba; background: rgba(93, 159, 118, 0.14); }
.learning-status.needs_review { color: #e2c88f; background: rgba(180, 143, 68, 0.14); }
.learning-confidence {
  margin-left: auto;
  color: rgba(244, 241, 236, 0.38);
  font: 11px monospace;
}
.learning-summary {
  color: rgba(244, 241, 236, 0.82);
  font-size: 13px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.learning-scope {
  margin-top: 6px;
  color: rgba(244, 241, 236, 0.4);
  font: 11px/1.5 monospace;
  overflow-wrap: anywhere;
}
.learning-sources {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
}
.learning-source {
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  color: rgba(141, 180, 190, 0.9);
  text-decoration: none;
  border-top: 1px dashed rgba(244, 241, 236, 0.08);
}
.learning-source:hover { color: #b6d5dc; }
.source-main {
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}
.source-title {
  display: -webkit-box;
  overflow: hidden;
  font-size: 13px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.source-meta {
  color: rgba(244, 241, 236, 0.34);
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.source-link-icon { flex: 0 0 auto; }
.spin { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 640px) {
  .learning-item-head { flex-wrap: wrap; }
  .learning-confidence { margin-left: 0; }
  .learning-source { align-items: flex-start; }
  .source-link-icon { margin-top: 2px; }
}

@media (prefers-reduced-motion: reduce) {
  .learning-chevron,
  .spin { animation: none; transition: none; }
}
</style>

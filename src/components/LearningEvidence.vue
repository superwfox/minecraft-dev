<template>
  <section v-if="taskId && (knowledgeCount > 0 || statusVisible)" class="learning-evidence">
    <button class="learning-toggle" type="button" @click="toggle">
      <BookOpenCheck :size="15" aria-hidden="true" />
      <span>本次依据</span>
      <span v-if="knowledgeCount" class="learning-count">{{ knowledgeCount }}</span>
      <ChevronDown :size="15" class="learning-chevron" :class="{ open: expanded }" aria-hidden="true" />
    </button>

    <div v-if="expanded" class="learning-body">
      <div v-if="loading" class="learning-empty">
        <LoaderCircle :size="15" class="spin" aria-hidden="true" />
        <span>正在读取证据</span>
      </div>
      <div v-else-if="error" class="learning-empty error">
        <span>{{ error }}</span>
        <button type="button" class="retry" title="重新加载" @click="load">
          <RefreshCw :size="14" aria-hidden="true" />
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
              <ExternalLink :size="13" aria-hidden="true" />
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

const props = defineProps<{
    taskId: string;
    knowledgeCount: number;
    learningStatus?: string;
}>();

const expanded = ref(false);
const loading = ref(false);
const error = ref("");
const items = ref<any[]>([]);
const loadedTaskId = ref("");
const statusVisible = computed(() => !!props.learningStatus && props.learningStatus !== "idle");

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
    loading.value = true;
    error.value = "";
    try {
        const resp = await fetch(`/api/learning/evidence?taskId=${encodeURIComponent(props.taskId)}`);
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json();
        items.value = Array.isArray(data.items) ? data.items : [];
        loadedTaskId.value = props.taskId;
    } catch {
        error.value = "证据暂时无法读取";
    } finally {
        loading.value = false;
    }
}

function toggle() {
    expanded.value = !expanded.value;
    if (expanded.value && loadedTaskId.value !== props.taskId) void load();
}

watch(() => props.taskId, () => {
    expanded.value = false;
    loadedTaskId.value = "";
    items.value = [];
    error.value = "";
});

watch(() => props.knowledgeCount, () => {
    if (expanded.value) void load();
});
</script>

<style scoped>
.learning-evidence {
  border-top: 1px solid rgba(209, 200, 182, 0.12);
  padding-top: 10px;
}
.learning-toggle {
  width: 100%;
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px;
  color: rgba(244, 241, 236, 0.72);
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  text-align: left;
}
.learning-toggle:hover { color: #f4f1ec; }
.learning-count {
  min-width: 20px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(67, 128, 145, 0.16);
  color: #8db4be;
  text-align: center;
  font-family: monospace;
  font-size: 10px;
}
.learning-chevron { margin-left: auto; transition: transform 0.18s; }
.learning-chevron.open { transform: rotate(180deg); }
.learning-body { padding: 6px 0 0; }
.learning-empty {
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: rgba(244, 241, 236, 0.42);
  font-size: 12px;
}
.learning-empty.error { color: #e6a394; }
.retry {
  width: 28px;
  height: 28px;
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
  padding: 10px 2px;
  border-top: 1px solid rgba(244, 241, 236, 0.08);
}
.learning-item:first-child { border-top: 0; }
.learning-item-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.learning-status {
  padding: 2px 6px;
  border-radius: 4px;
  color: rgba(244, 241, 236, 0.58);
  background: rgba(244, 241, 236, 0.08);
  font-size: 10px;
}
.learning-status.active { color: #a9d8ba; background: rgba(93, 159, 118, 0.14); }
.learning-status.needs_review { color: #e2c88f; background: rgba(180, 143, 68, 0.14); }
.learning-confidence { margin-left: auto; color: rgba(244, 241, 236, 0.34); font: 10px monospace; }
.learning-summary { color: rgba(244, 241, 236, 0.8); font-size: 12px; line-height: 1.55; }
.learning-scope { margin-top: 5px; color: rgba(244, 241, 236, 0.38); font: 10px/1.5 monospace; overflow-wrap: anywhere; }
.learning-sources { margin-top: 8px; display: flex; flex-direction: column; }
.learning-source {
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  color: rgba(141, 180, 190, 0.88);
  text-decoration: none;
  border-top: 1px dashed rgba(244, 241, 236, 0.08);
}
.learning-source:hover { color: #b6d5dc; }
.source-main { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: 2px; }
.source-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.source-meta { color: rgba(244, 241, 236, 0.3); font-size: 9px; }
.spin { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>

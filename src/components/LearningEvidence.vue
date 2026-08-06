<template>
  <section v-if="taskId && (knowledgeCount > 0 || publicSourceCount > 0 || statusVisible)" class="learning-evidence">
    <button class="learning-toggle" type="button" @click="toggle"
            :aria-expanded="expanded" :aria-controls="bodyId">
      <BookOpenCheck :size="17" aria-hidden="true" />
      <span>学习证据</span>
      <span v-if="publicSourceCount" class="learning-count">{{ publicSourceCount }} 个 URL</span>
      <span v-if="knowledgeCount" class="learning-count recipe">{{ knowledgeCount }} 条结论</span>
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
      <div v-else-if="!items.length && !searchedSources.length" class="learning-empty">
        本次没有产生可展示的联网证据
      </div>

      <div v-else class="evidence-sections">
        <section v-if="searchedSources.length" class="evidence-section">
          <header class="evidence-section-head">
            <Search :size="16" aria-hidden="true" />
            <h3>搜索过的来源</h3>
            <span>{{ searchedSources.length }}</span>
          </header>
          <div class="searched-list">
            <article v-for="(source, index) in searchedSources"
                     :key="`${source.needId}:${source.canonicalUrl || source.url}:${index}`"
                     class="searched-source">
              <div class="searched-head">
                <span class="source-status" :class="source.status">{{ sourceStatusLabel(source.status) }}</span>
                <span class="source-meta-inline">
                  {{ authorityLabel(source.authority) }} · {{ sourceTypeLabel(source.sourceType) }}
                </span>
              </div>
              <div v-if="source.question" class="source-question">
                <span>技术问题</span>
                <p>{{ source.question }}</p>
              </div>
              <div class="source-reason">
                <span>搜索理由</span>
                <p>{{ source.reason || "未记录搜索理由" }}</p>
              </div>
              <a v-if="sourceLinkUrl(source)" class="searched-link" :href="sourceLinkUrl(source)"
                 target="_blank" rel="noopener noreferrer">
                <span class="searched-link-copy">
                  <strong>{{ source.title || sourceHost(source) }}</strong>
                  <small>{{ sourceDisplayUrl(source) }}</small>
                </span>
                <ExternalLink :size="15" aria-hidden="true" />
              </a>
              <div v-else class="searched-link invalid">
                <span class="searched-link-copy">
                  <strong>未通过安全校验的 URL</strong>
                  <small>{{ sourceDisplayUrl(source) || "候选未提供可展示的 URL" }}</small>
                </span>
              </div>
              <div v-if="source.rejectionCode" class="rejection-reason">
                {{ rejectionLabel(source.rejectionCode) }}
                <code>{{ source.rejectionCode }}</code>
              </div>
            </article>
          </div>
        </section>

        <section v-if="items.length" class="evidence-section">
          <header class="evidence-section-head">
            <Code2 :size="16" aria-hidden="true" />
            <h3>验证结论与方法通例</h3>
            <span>{{ items.length }}</span>
          </header>
          <div class="learning-items">
            <article v-for="item in items" :key="item.knowledgeId" class="learning-item">
              <div class="learning-item-head">
                <span class="learning-status" :class="item.status">{{ statusLabel(item.status) }}</span>
                <span class="learning-confidence">{{ Math.round(item.confidence * 100) }}%</span>
              </div>
              <div class="learning-summary">{{ item.summary }}</div>
              <div v-if="item.reason" class="learning-reason">
                <span>学习原因</span>
                <p>{{ item.reason.message }}</p>
              </div>
              <div v-if="item.scope" class="learning-scope">{{ formatScope(item.scope) }}</div>

              <div v-if="item.recipe" class="recipe-block">
                <div class="recipe-head">
                  <strong>{{ item.recipe.title }}</strong>
                  <span>{{ integrationLabel(item.recipe.integrationKind) }}</span>
                </div>
                <dl class="recipe-facts">
                  <div>
                    <dt>适用版本</dt>
                    <dd>{{ item.recipe.versionScope }}</dd>
                  </div>
                  <div v-if="item.recipe.prerequisites.length">
                    <dt>前置条件</dt>
                    <dd>{{ item.recipe.prerequisites.join("；") }}</dd>
                  </div>
                  <div v-if="item.recipe.notes.length">
                    <dt>使用说明</dt>
                    <dd>{{ item.recipe.notes.join("；") }}</dd>
                  </div>
                </dl>
                <div v-if="item.recipe.imports.length" class="code-group">
                  <div class="code-label">Imports</div>
                  <pre><code>{{ item.recipe.imports.join("\n") }}</code></pre>
                </div>
                <div class="code-group">
                  <div class="code-label">Java 方法</div>
                  <pre><code>{{ item.recipe.code }}</code></pre>
                </div>
              </div>
              <div v-else class="recipe-empty">该结论未形成可复用的方法通例，本次不会注入代码生成。</div>

              <div v-if="item.sources.length" class="learning-sources">
                <a v-for="source in item.sources" :key="source.sourceId"
                   class="learning-source" :href="source.url" target="_blank" rel="noopener noreferrer">
                  <span class="source-main">
                    <span class="source-title">{{ source.title }}</span>
                    <span class="source-meta">
                      {{ source.relation === "contradicts" ? "反驳" : "支持" }} ·
                      {{ authorityLabel(source.authority) }} · {{ sourceTypeLabel(source.sourceType) }} ·
                      {{ formatDate(source.publishedAt || source.fetchedAt) }}
                    </span>
                  </span>
                  <ExternalLink :size="15" class="source-link-icon" aria-hidden="true" />
                </a>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
    BookOpenCheck,
    ChevronDown,
    Code2,
    ExternalLink,
    LoaderCircle,
    RefreshCw,
    Search,
} from "lucide-vue-next";
import {
    isLearningEvidenceTerminalStatus,
    resolveLearningEvidenceResult,
    type LearningEvidenceIdentity,
    type LearningEvidenceItem,
    type LearningSearchedSource,
} from "../logic/learningEvidenceState";

const props = defineProps<{
    taskId: string;
    knowledgeCount: number;
    searchedSourceCount?: number;
    learningJobId?: string;
    learningStage?: string;
    learningStatus?: string;
    learningRevision?: number;
}>();

const expanded = ref(false);
const loading = ref(false);
const error = ref("");
const items = ref<LearningEvidenceItem[]>([]);
const searchedSources = ref<LearningSearchedSource[]>([]);
const loadedKey = ref("");
let loadSequence = 0;

const statusVisible = computed(() => !!props.learningStatus && props.learningStatus !== "idle");
const publicSourceCount = computed(() => Math.max(
    searchedSources.value.length,
    Math.max(0, Number(props.searchedSourceCount) || 0),
));
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
        Math.max(0, Number(props.searchedSourceCount) || 0),
        terminalStatus,
    ].join(":");
});

function statusLabel(status: string) {
    if (status === "active") return "已采用";
    if (status === "needs_review") return "待审核";
    if (status === "rejected") return "已驳回";
    return "未采用";
}

function sourceStatusLabel(status: LearningSearchedSource["status"]) {
    if (status === "supports") return "已接纳";
    if (status === "contradicts") return "冲突证据";
    if (status === "fetched") return "已抓取";
    if (status === "rejected") return "已拒绝";
    if (status === "skipped") return "未尝试";
    return "待抓取";
}

function rejectionLabel(code: string) {
    const labels: Record<string, string> = {
        invalid_url: "URL 未通过安全校验",
        timeout: "抓取超时",
        http_4xx: "来源返回 4xx",
        http_5xx: "来源返回 5xx",
        too_large: "内容超过大小限制",
        unsupported_type: "内容类型不受支持",
        too_thin: "可验证正文过少",
        duplicate: "与已处理候选重复",
        budget_exhausted: "本次抓取预算已用尽",
        source_limit: "已达到来源数量上限",
    };
    return labels[code] || "来源未被接纳";
}

function authorityLabel(value: string) {
    const labels: Record<string, string> = {
        ground_truth: "目标版本实证",
        official: "官方来源",
        secondary: "二级来源",
        untrusted: "社区来源",
        unclassified: "待分类",
    };
    return labels[value] || value;
}

function sourceTypeLabel(value: string) {
    const labels: Record<string, string> = {
        artifact: "构件元数据",
        repository: "源码仓库",
        javadoc: "Javadoc",
        release: "发行说明",
        documentation: "官方文档",
        community: "社区资料",
        unclassified: "未分类",
    };
    return labels[value] || value;
}

function integrationLabel(value: string) {
    if (value === "nms") return "NMS";
    if (value === "craftbukkit") return "CraftBukkit";
    if (value === "version_reflection") return "版本反射";
    return "第三方插件 API";
}

function sourceDisplayUrl(source: LearningSearchedSource) {
    return source.canonicalUrl || source.url;
}

function sourceLinkUrl(source: LearningSearchedSource) {
    try {
        const url = new URL(sourceDisplayUrl(source));
        return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
    } catch {
        return "";
    }
}

function sourceHost(source: LearningSearchedSource) {
    try { return new URL(sourceDisplayUrl(source)).hostname; } catch { return "候选来源"; }
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
            data.searchedSources,
        );
        items.value = result.items;
        searchedSources.value = result.searchedSources;
        loadedKey.value = result.cache ? requestedKey : "";
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
    searchedSources.value = [];
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
  padding: 2px 7px;
  border-radius: 4px;
  background: rgba(67, 128, 145, 0.16);
  color: #8db4be;
  font-family: monospace;
  font-size: 11px;
  white-space: nowrap;
}
.learning-count.recipe {
  background: rgba(93, 159, 118, 0.14);
  color: #a9d8ba;
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
.evidence-sections,
.learning-items,
.searched-list { display: flex; flex-direction: column; }
.evidence-section { padding: 12px 0 2px; border-top: 1px solid rgba(244, 241, 236, 0.08); }
.evidence-section:first-child { border-top: 0; }
.evidence-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: rgba(244, 241, 236, 0.68);
}
.evidence-section-head h3 { margin: 0; font-size: 12px; font-weight: 650; }
.evidence-section-head span { margin-left: auto; color: rgba(244, 241, 236, 0.34); font: 11px monospace; }
.searched-source,
.learning-item { padding: 12px 2px; border-top: 1px solid rgba(244, 241, 236, 0.08); }
.searched-source:first-child,
.learning-item:first-child { border-top: 0; }
.searched-head,
.learning-item-head,
.recipe-head { display: flex; align-items: center; gap: 8px; }
.source-status,
.learning-status,
.recipe-head span {
  padding: 2px 7px;
  border-radius: 4px;
  color: rgba(244, 241, 236, 0.58);
  background: rgba(244, 241, 236, 0.08);
  font-size: 11px;
}
.source-status.supports,
.learning-status.active { color: #a9d8ba; background: rgba(93, 159, 118, 0.14); }
.source-status.contradicts,
.source-status.rejected { color: #e6a394; background: rgba(183, 91, 74, 0.14); }
.source-status.fetched { color: #a8ccd5; background: rgba(67, 128, 145, 0.16); }
.source-status.skipped,
.learning-status.needs_review { color: #e2c88f; background: rgba(180, 143, 68, 0.14); }
.source-meta-inline,
.learning-confidence { margin-left: auto; color: rgba(244, 241, 236, 0.38); font: 11px monospace; }
.source-question,
.source-reason,
.learning-reason { margin-top: 8px; }
.source-question > span,
.source-reason > span,
.learning-reason > span,
.code-label {
  display: block;
  margin-bottom: 3px;
  color: rgba(244, 241, 236, 0.38);
  font-size: 11px;
  font-weight: 600;
}
.source-question p,
.source-reason p,
.learning-reason p {
  margin: 0;
  color: rgba(244, 241, 236, 0.7);
  font-size: 12.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.searched-link,
.learning-source {
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 9px;
  padding: 8px 0;
  color: rgba(141, 180, 190, 0.9);
  text-decoration: none;
  border-top: 1px dashed rgba(244, 241, 236, 0.08);
}
.searched-link:hover,
.learning-source:hover { color: #b6d5dc; }
.searched-link.invalid { color: rgba(244, 241, 236, 0.4); }
.searched-link-copy,
.source-main { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: 3px; }
.searched-link-copy strong,
.source-title { font-size: 13px; line-height: 1.4; overflow-wrap: anywhere; }
.searched-link-copy small,
.source-meta { color: rgba(244, 241, 236, 0.34); font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
.rejection-reason {
  display: flex;
  align-items: baseline;
  gap: 7px;
  color: rgba(230, 163, 148, 0.72);
  font-size: 11px;
}
.rejection-reason code { color: rgba(244, 241, 236, 0.36); font-size: 10px; }
.learning-summary { color: rgba(244, 241, 236, 0.82); font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
.learning-scope { margin-top: 6px; color: rgba(244, 241, 236, 0.4); font: 11px/1.5 monospace; overflow-wrap: anywhere; }
.recipe-block { margin-top: 12px; padding-top: 11px; border-top: 1px dashed rgba(244, 241, 236, 0.1); }
.recipe-head { align-items: flex-start; }
.recipe-head strong { min-width: 0; color: rgba(244, 241, 236, 0.88); font-size: 13px; line-height: 1.45; }
.recipe-head span { margin-left: auto; flex: 0 0 auto; color: #a8ccd5; background: rgba(67, 128, 145, 0.14); }
.recipe-facts { margin: 10px 0 0; }
.recipe-facts div { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 10px; padding: 4px 0; }
.recipe-facts dt { color: rgba(244, 241, 236, 0.38); font-size: 11px; }
.recipe-facts dd { margin: 0; color: rgba(244, 241, 236, 0.68); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.code-group { margin-top: 10px; }
.code-group pre {
  max-width: 100%;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  border: 1px solid rgba(244, 241, 236, 0.1);
  border-radius: 4px;
  background: #090907;
}
.code-group code { color: rgba(224, 231, 232, 0.86); font: 11px/1.55 "SFMono-Regular", Consolas, monospace; white-space: pre; }
.recipe-empty { margin-top: 10px; color: rgba(226, 200, 143, 0.62); font-size: 11.5px; line-height: 1.5; }
.learning-sources { margin-top: 10px; display: flex; flex-direction: column; }
.source-link-icon { flex: 0 0 auto; }
.spin { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 640px) {
  .learning-toggle { flex-wrap: wrap; }
  .learning-chevron { margin-left: 0; }
  .searched-head,
  .learning-item-head { flex-wrap: wrap; }
  .source-meta-inline,
  .learning-confidence { width: 100%; margin-left: 0; }
  .searched-link,
  .learning-source { align-items: flex-start; }
  .recipe-head { flex-direction: column; }
  .recipe-head span { margin-left: 0; }
  .recipe-facts div { grid-template-columns: 1fr; gap: 2px; }
}

@media (prefers-reduced-motion: reduce) {
  .learning-chevron,
  .spin { animation: none; transition: none; }
}
</style>

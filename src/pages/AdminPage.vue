<template>
  <div class="admin-page">
    <header class="ad-head">
      <h2 class="ad-title">管理后台</h2>
      <button class="ad-icon-btn" type="button" title="刷新当前列表" :disabled="refreshing" @click="refreshCurrent">
        <RefreshCw :size="16" :class="{ spin: refreshing }" aria-hidden="true" />
      </button>
    </header>

    <nav class="ad-tabs" aria-label="管理分类">
      <button type="button" class="ad-tab" :class="{ active: activeTab === 'sponsor' }"
              :aria-selected="activeTab === 'sponsor'" @click="activeTab = 'sponsor'">
        <CircleDollarSign :size="16" aria-hidden="true" />
        <span>充值审批</span>
        <span class="ad-count">{{ sponsorItems.length }}</span>
      </button>
      <button type="button" class="ad-tab" :class="{ active: activeTab === 'knowledge' }"
              :aria-selected="activeTab === 'knowledge'" @click="activeTab = 'knowledge'">
        <BookOpenCheck :size="16" aria-hidden="true" />
        <span>知识审核</span>
        <span class="ad-count">{{ knowledgeItems.length }}</span>
      </button>
    </nav>

    <div v-if="loading" class="ad-tip loading-tip">
      <LoaderCircle :size="16" class="spin" aria-hidden="true" />
      <span>加载中</span>
    </div>
    <div v-else-if="forbidden" class="ad-tip warn">无权限，请使用配置在 ADMIN_UID 中的账号登录。</div>

    <template v-else>
      <section v-if="activeTab === 'sponsor'" class="ad-section">
        <div class="ad-bar"><span>待审 {{ sponsorItems.length }} 条</span></div>
        <div v-if="!sponsorItems.length" class="ad-tip">暂无充值待审记录。</div>
        <div v-else class="ad-table-wrap">
          <table class="ad-table">
            <thead>
              <tr><th>用户</th><th>金额</th><th>备注码</th><th>时间</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in sponsorItems" :key="item.code">
                <td>{{ item.login }}</td>
                <td class="ad-amount">¥{{ item.amount }}</td>
                <td class="ad-code">{{ item.code }}</td>
                <td class="ad-time">{{ formatDateTime(item.ts) }}</td>
                <td class="ad-actions">
                  <button class="ad-btn approve" type="button" :disabled="busySponsor === item.code"
                          @click="reviewSponsor(item, 'approve')">
                    <Check :size="14" aria-hidden="true" /><span>通过</span>
                  </button>
                  <button class="ad-btn reject" type="button" :disabled="busySponsor === item.code"
                          @click="reviewSponsor(item, 'reject')">
                    <X :size="14" aria-hidden="true" /><span>驳回</span>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="ad-hint">通过前请在收款记录中核对备注码与金额。</div>
      </section>

      <section v-else class="ad-section">
        <div class="ad-bar"><span>知识条目 {{ knowledgeItems.length }} 条</span></div>
        <div v-if="!knowledgeItems.length" class="ad-tip">暂无知识审核条目。</div>
        <div v-else class="knowledge-list">
          <article v-for="item in knowledgeItems" :key="item.knowledgeId" class="knowledge-item">
            <div class="knowledge-head">
              <div class="knowledge-badges">
                <span class="ad-badge kind">{{ kindLabel(item.kind) }}</span>
                <span class="ad-badge" :class="`status-${item.status}`" :title="knowledgeStatusTitle(item)">
                  {{ knowledgeStatusLabel(item.status) }}
                </span>
                <span class="ad-badge" :class="`risk-${item.risk}`">{{ riskLabel(item.risk) }}</span>
                <span class="ad-badge confidence">{{ Math.round(item.confidence * 100) }}%</span>
                <span class="ad-badge revision">rev {{ item.revision }}</span>
              </div>
              <time class="ad-time" :datetime="isoDate(item.updatedAt)">{{ formatDateTime(item.updatedAt) }}</time>
            </div>

            <div class="knowledge-summary">{{ item.summary }}</div>
            <div class="knowledge-id">{{ item.lookupKey }}</div>

            <dl v-if="scopeEntries(item.scope).length" class="knowledge-scope">
              <template v-for="entry in scopeEntries(item.scope)" :key="entry[0]">
                <dt>{{ scopeLabel(entry[0]) }}</dt><dd>{{ entry[1] }}</dd>
              </template>
            </dl>

            <details v-if="hasPayload(item.payload)" class="knowledge-payload">
              <summary>结构化结论</summary>
              <pre>{{ prettyPayload(item.payload) }}</pre>
            </details>

            <div class="evidence-list">
              <div v-if="!item.sources.length" class="evidence-empty">没有可展示的证据来源。</div>
              <section v-for="source in item.sources" :key="source.sourceId" class="evidence-source"
                       :class="{ contradicts: source.relation === 'contradicts' }">
                <div class="source-head">
                  <span class="source-relation">{{ relationLabel(source.relation) }}</span>
                  <a :href="source.url" target="_blank" rel="noopener noreferrer" class="source-link">
                    <span>{{ source.title }}</span><ExternalLink :size="13" aria-hidden="true" />
                  </a>
                </div>
                <div class="source-meta">
                  {{ authorityLabel(source.authority) }} · {{ source.sourceType }} · {{ formatDate(source.publishedAt || source.fetchedAt) }}
                </div>
                <div v-if="source.excerpt" class="source-excerpt">{{ source.excerpt }}</div>
              </section>
            </div>

            <textarea v-model="reviewNotes[item.knowledgeId]" class="review-note" rows="2" maxlength="500"
                      placeholder="审核备注（可选）" />
            <div class="knowledge-actions">
              <template v-if="item.status === 'needs_review'">
                <button class="ad-btn approve" type="button"
                        :title="item.kind === 'strategy' ? '策略知识需等待后续晋升机制' : '批准并激活最新 revision'"
                        :disabled="busyKnowledge === item.knowledgeId || item.kind === 'strategy'"
                        @click="reviewKnowledge(item, 'approve')">
                  <Check :size="14" aria-hidden="true" /><span>通过</span>
                </button>
                <button class="ad-btn reject" type="button" :disabled="busyKnowledge === item.knowledgeId"
                        @click="reviewKnowledge(item, 'reject')">
                  <X :size="14" aria-hidden="true" /><span>驳回</span>
                </button>
              </template>
              <button class="ad-btn deprecate" type="button" :disabled="busyKnowledge === item.knowledgeId"
                      @click="reviewKnowledge(item, 'deprecate')">
                <ShieldBan :size="14" aria-hidden="true" /><span>失效</span>
              </button>
            </div>
          </article>
        </div>
      </section>

      <div v-if="message" class="ad-message" :class="messageKind">{{ message }}</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import {
    BookOpenCheck,
    Check,
    CircleDollarSign,
    ExternalLink,
    LoaderCircle,
    RefreshCw,
    ShieldBan,
    X,
} from "lucide-vue-next";

type AdminTab = "sponsor" | "knowledge";
type SponsorAction = "approve" | "reject";
type KnowledgeAction = "approve" | "reject" | "deprecate";

type SponsorItem = {
    uid: string;
    login: string;
    amount: number;
    code: string;
    ts: number;
};

type KnowledgeSource = {
    sourceId: string;
    title: string;
    url: string;
    sourceType: string;
    authority: string;
    publishedAt?: number;
    fetchedAt: number;
    excerpt: string;
    relation: string;
};

type KnowledgeItem = {
    knowledgeId: string;
    kind: "fact" | "strategy";
    lookupKey: string;
    scope: Record<string, unknown>;
    payload: Record<string, unknown>;
    summary: string;
    risk: "low" | "medium" | "high";
    confidence: number;
    status: "active" | "needs_review" | "expired";
    expiresAt: number;
    revision: number;
    updatedAt: number;
    sources: KnowledgeSource[];
};

const activeTab = ref<AdminTab>("sponsor");
const sponsorItems = ref<SponsorItem[]>([]);
const knowledgeItems = ref<KnowledgeItem[]>([]);
const reviewNotes = reactive<Record<string, string>>({});
const loading = ref(true);
const refreshing = ref(false);
const forbidden = ref(false);
const busySponsor = ref("");
const busyKnowledge = ref("");
const message = ref("");
const messageKind = ref<"success" | "error">("success");

async function requestJson(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    let data: any = {};
    try { data = await response.json(); } catch { /* handled below */ }
    if (response.status === 401 || response.status === 403) {
        forbidden.value = true;
        throw new Error(data.reason || "无权限");
    }
    if (!response.ok || data.ok === false) throw new Error(data.reason || `请求失败 (${response.status})`);
    return data;
}

async function loadSponsor() {
    const data = await requestJson("/api/sponsor/admin/list");
    sponsorItems.value = Array.isArray(data.items) ? data.items : [];
}

async function loadKnowledge() {
    const data = await requestJson("/api/learning/admin/list");
    knowledgeItems.value = Array.isArray(data.items) ? data.items : [];
}

async function loadAll() {
    loading.value = true;
    forbidden.value = false;
    message.value = "";
    try {
        await Promise.all([loadSponsor(), loadKnowledge()]);
    } catch (error: any) {
        if (!forbidden.value) setMessage(error?.message || "加载失败", "error");
    } finally {
        loading.value = false;
    }
}

async function refreshCurrent() {
    refreshing.value = true;
    message.value = "";
    try {
        if (activeTab.value === "sponsor") await loadSponsor();
        else await loadKnowledge();
    } catch (error: any) {
        setMessage(error?.message || "刷新失败", "error");
    } finally {
        refreshing.value = false;
    }
}

async function reviewSponsor(item: SponsorItem, action: SponsorAction) {
    busySponsor.value = item.code;
    message.value = "";
    try {
        const result = await requestJson("/api/sponsor/admin/review", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: item.code, action }),
        });
        sponsorItems.value = sponsorItems.value.filter((entry) => entry.code !== item.code);
        setMessage(
            action === "approve"
                ? `已通过 ${item.login}，增加 ${result.added ?? item.amount} 件额度`
                : `已驳回 ${item.login}`,
            "success",
        );
    } catch (error: any) {
        setMessage(error?.message || "操作失败", "error");
    } finally {
        busySponsor.value = "";
    }
}

async function reviewKnowledge(item: KnowledgeItem, action: KnowledgeAction) {
    busyKnowledge.value = item.knowledgeId;
    message.value = "";
    try {
        const result = await requestJson("/api/learning/admin/review", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                knowledgeId: item.knowledgeId,
                action,
                note: reviewNotes[item.knowledgeId] || "",
            }),
        });
        if (action === "approve" && result.item) {
            const index = knowledgeItems.value.findIndex(
                (entry) => entry.knowledgeId === item.knowledgeId,
            );
            if (index >= 0) {
                knowledgeItems.value[index] = {
                    ...item,
                    ...result.item,
                    sources: item.sources,
                };
            }
        } else {
            knowledgeItems.value = knowledgeItems.value.filter(
                (entry) => entry.knowledgeId !== item.knowledgeId,
            );
        }
        delete reviewNotes[item.knowledgeId];
        const labels: Record<KnowledgeAction, string> = {
            approve: "已批准并激活",
            reject: "已驳回",
            deprecate: "已标记失效",
        };
        setMessage(`${labels[action]} rev ${item.revision}`, "success");
    } catch (error: any) {
        setMessage(error?.message || "知识审核失败", "error");
        await loadKnowledge().catch(() => { /* 保留原错误 */ });
    } finally {
        busyKnowledge.value = "";
    }
}

function setMessage(value: string, kind: "success" | "error") {
    message.value = value;
    messageKind.value = kind;
}

function formatDateTime(timestamp: number) {
    if (!timestamp) return "时间未知";
    try { return new Date(timestamp).toLocaleString("zh-CN"); } catch { return "时间未知"; }
}

function formatDate(timestamp?: number) {
    if (!timestamp) return "日期未知";
    try { return new Date(timestamp).toLocaleDateString("zh-CN"); } catch { return "日期未知"; }
}

function isoDate(timestamp: number) {
    try { return new Date(timestamp).toISOString(); } catch { return ""; }
}

function kindLabel(kind: string) {
    return kind === "strategy" ? "策略" : "事实";
}

function riskLabel(risk: string) {
    if (risk === "high") return "高风险";
    if (risk === "medium") return "中风险";
    return "低风险";
}

function knowledgeStatusLabel(status: KnowledgeItem["status"]) {
    if (status === "active") return "有效";
    if (status === "expired") return "已过期";
    return "待审核";
}

function knowledgeStatusTitle(item: KnowledgeItem) {
    if (item.status === "active" && item.expiresAt > 0) {
        return `有效至 ${formatDateTime(item.expiresAt)}`;
    }
    if (item.status === "expired" && item.expiresAt > 0) {
        return `已于 ${formatDateTime(item.expiresAt)} 过期，需手动失效后重新查证`;
    }
    return knowledgeStatusLabel(item.status);
}

function scopeLabel(key: string) {
    const labels: Record<string, string> = {
        coreType: "核心",
        mcVersion: "版本",
        dependency: "依赖",
        packageName: "包名",
        symbol: "符号",
    };
    return labels[key] || key;
}

function scopeEntries(scope: Record<string, unknown>) {
    if (!scope || typeof scope !== "object") return [] as [string, string][];
    return Object.entries(scope)
        .filter(([, value]) => value != null && value !== "")
        .map(([key, value]) => [key, String(value)] as [string, string]);
}

function hasPayload(payload: Record<string, unknown>) {
    return !!payload && typeof payload === "object" && Object.keys(payload).length > 0;
}

function prettyPayload(payload: Record<string, unknown>) {
    try { return JSON.stringify(payload, null, 2); } catch { return String(payload); }
}

function relationLabel(relation: string) {
    return relation === "contradicts" ? "冲突" : "支持";
}

function authorityLabel(authority: string) {
    const labels: Record<string, string> = {
        ground_truth: "Ground truth",
        official: "官方",
        secondary: "次级来源",
        untrusted: "辅助来源",
    };
    return labels[authority] || authority;
}

onMounted(loadAll);
</script>

<style scoped>
.admin-page {
    width: min(1040px, 100%);
    margin: 0 auto;
    padding: 96px 20px 64px;
    color: #f4f1ec;
    font-family: "ZhuoKai", system-ui, sans-serif;
}
.ad-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 40px;
    margin-bottom: 14px;
}
.ad-title { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: 0; }
.ad-icon-btn {
    width: 34px;
    height: 34px;
    display: inline-grid;
    place-items: center;
    padding: 0;
    color: rgba(244, 241, 236, 0.7);
    background: transparent;
    border: 1px solid rgba(244, 241, 236, 0.16);
    border-radius: 6px;
    cursor: pointer;
}
.ad-icon-btn:hover { color: #f4f1ec; border-color: rgba(244, 241, 236, 0.3); }
.ad-icon-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.ad-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 22px;
    border-bottom: 1px solid rgba(244, 241, 236, 0.12);
}
.ad-tab {
    min-height: 40px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    color: rgba(244, 241, 236, 0.52);
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    font: inherit;
    font-size: 13px;
    letter-spacing: 0;
    cursor: pointer;
}
.ad-tab:hover { color: rgba(244, 241, 236, 0.82); }
.ad-tab.active { color: #f4f1ec; border-bottom-color: #68a9b7; }
.ad-count {
    min-width: 20px;
    padding: 1px 6px;
    color: rgba(244, 241, 236, 0.58);
    background: rgba(244, 241, 236, 0.08);
    border-radius: 4px;
    font: 10px/16px monospace;
    text-align: center;
}
.ad-section { width: 100%; }
.ad-tip {
    min-height: 64px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px 2px;
    color: rgba(244, 241, 236, 0.48);
    font-size: 13px;
}
.ad-tip.warn { color: #e9a094; }
.loading-tip { justify-content: center; }
.ad-bar {
    min-height: 32px;
    display: flex;
    align-items: center;
    margin-bottom: 8px;
    color: rgba(244, 241, 236, 0.58);
    font-size: 12px;
}
.ad-table-wrap { width: 100%; overflow-x: auto; }
.ad-table { width: 100%; min-width: 650px; border-collapse: collapse; font-size: 13px; }
.ad-table th,
.ad-table td {
    padding: 11px 8px;
    border-bottom: 1px solid rgba(244, 241, 236, 0.09);
    text-align: left;
}
.ad-table th { color: rgba(244, 241, 236, 0.4); font-size: 11px; font-weight: 400; }
.ad-amount { color: #e6c477; }
.ad-code { color: #e6c477; font-family: monospace; letter-spacing: 0; }
.ad-time { color: rgba(244, 241, 236, 0.36); font-size: 11px; white-space: nowrap; }
.ad-actions,
.knowledge-actions { display: flex; align-items: center; gap: 6px; }
.ad-btn {
    min-height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 4px 10px;
    color: rgba(244, 241, 236, 0.76);
    background: rgba(244, 241, 236, 0.05);
    border: 1px solid rgba(244, 241, 236, 0.16);
    border-radius: 6px;
    font: inherit;
    font-size: 12px;
    letter-spacing: 0;
    cursor: pointer;
    white-space: nowrap;
}
.ad-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.ad-btn.approve { color: #abd9ba; background: rgba(91, 157, 116, 0.13); border-color: rgba(91, 157, 116, 0.36); }
.ad-btn.reject { color: #edaaa0; background: rgba(187, 91, 78, 0.11); border-color: rgba(187, 91, 78, 0.34); }
.ad-btn.deprecate { color: #e2c88f; background: rgba(180, 143, 68, 0.11); border-color: rgba(180, 143, 68, 0.34); }
.ad-hint { margin-top: 12px; color: rgba(244, 241, 236, 0.34); font-size: 11px; }
.knowledge-list { border-top: 1px solid rgba(244, 241, 236, 0.1); }
.knowledge-item { padding: 18px 2px 20px; border-bottom: 1px solid rgba(244, 241, 236, 0.1); }
.knowledge-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.knowledge-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.ad-badge {
    min-height: 20px;
    display: inline-flex;
    align-items: center;
    padding: 2px 7px;
    color: rgba(244, 241, 236, 0.52);
    background: rgba(244, 241, 236, 0.07);
    border-radius: 4px;
    font-size: 10px;
    letter-spacing: 0;
}
.ad-badge.kind { color: #9fc7d0; background: rgba(67, 128, 145, 0.14); }
.ad-badge.status-needs_review { color: #e2c88f; background: rgba(180, 143, 68, 0.12); }
.ad-badge.status-active { color: #abd9ba; background: rgba(91, 157, 116, 0.12); }
.ad-badge.status-expired { color: #edaaa0; background: rgba(187, 91, 78, 0.12); }
.ad-badge.risk-low { color: #abd9ba; background: rgba(91, 157, 116, 0.12); }
.ad-badge.risk-medium { color: #e2c88f; background: rgba(180, 143, 68, 0.12); }
.ad-badge.risk-high { color: #edaaa0; background: rgba(187, 91, 78, 0.12); }
.ad-badge.confidence,
.ad-badge.revision { font-family: monospace; }
.knowledge-summary { margin-top: 12px; color: rgba(244, 241, 236, 0.9); font-size: 14px; line-height: 1.65; overflow-wrap: anywhere; }
.knowledge-id { margin-top: 5px; color: rgba(244, 241, 236, 0.3); font: 10px/1.5 monospace; overflow-wrap: anywhere; }
.knowledge-scope {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 4px 10px;
    margin: 12px 0 0;
    font-size: 11px;
}
.knowledge-scope dt { color: rgba(244, 241, 236, 0.34); }
.knowledge-scope dd { margin: 0; color: rgba(244, 241, 236, 0.65); font-family: monospace; overflow-wrap: anywhere; }
.knowledge-payload { margin-top: 12px; color: rgba(244, 241, 236, 0.54); font-size: 11px; }
.knowledge-payload summary { width: fit-content; cursor: pointer; }
.knowledge-payload pre {
    max-height: 220px;
    margin: 8px 0 0;
    padding: 10px;
    overflow: auto;
    color: rgba(244, 241, 236, 0.72);
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(244, 241, 236, 0.08);
    border-radius: 4px;
    font: 10px/1.55 monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.evidence-list { margin-top: 14px; border-top: 1px dashed rgba(244, 241, 236, 0.1); }
.evidence-empty { padding: 12px 0; color: rgba(244, 241, 236, 0.36); font-size: 11px; }
.evidence-source { padding: 11px 0; border-bottom: 1px dashed rgba(244, 241, 236, 0.08); }
.evidence-source.contradicts { border-left: 2px solid rgba(187, 91, 78, 0.5); padding-left: 10px; }
.source-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.source-relation {
    flex: 0 0 auto;
    padding: 1px 5px;
    color: #abd9ba;
    background: rgba(91, 157, 116, 0.12);
    border-radius: 3px;
    font-size: 9px;
}
.contradicts .source-relation { color: #edaaa0; background: rgba(187, 91, 78, 0.12); }
.source-link {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 5px;
    color: #9fc7d0;
    text-decoration: none;
    font-size: 11px;
}
.source-link span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-link:hover { color: #c2dce2; }
.source-meta { margin-top: 4px; color: rgba(244, 241, 236, 0.3); font-size: 9px; }
.source-excerpt {
    max-height: 150px;
    margin-top: 7px;
    padding-right: 8px;
    overflow: auto;
    color: rgba(244, 241, 236, 0.58);
    font-size: 11px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.review-note {
    width: 100%;
    min-height: 56px;
    margin-top: 14px;
    padding: 8px 10px;
    resize: vertical;
    color: #f4f1ec;
    background: rgba(0, 0, 0, 0.16);
    border: 1px solid rgba(244, 241, 236, 0.14);
    border-radius: 6px;
    outline: none;
    font-family: inherit;
    font-size: 12px;
    line-height: 1.5;
    letter-spacing: 0;
    box-sizing: border-box;
}
.review-note:focus { border-color: rgba(104, 169, 183, 0.58); }
.review-note::placeholder { color: rgba(244, 241, 236, 0.28); }
.knowledge-actions { margin-top: 10px; flex-wrap: wrap; }
.ad-message { margin-top: 16px; font-size: 12px; }
.ad-message.success { color: #abd9ba; }
.ad-message.error { color: #edaaa0; }
.spin { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 640px) {
    .admin-page { padding: 84px 14px 48px; }
    .ad-tab { flex: 1; justify-content: center; padding: 0 8px; }
    .knowledge-head { align-items: flex-start; flex-direction: column; gap: 8px; }
    .knowledge-scope { grid-template-columns: 1fr; gap: 2px; }
    .knowledge-scope dd { margin-bottom: 5px; }
    .source-head { align-items: flex-start; }
    .source-link { align-items: flex-start; }
    .ad-actions { min-width: 170px; }
}
</style>

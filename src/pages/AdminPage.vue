<template>
  <div class="admin-page">
    <h2 class="ad-title">充值审批后台</h2>

    <div v-if="loading" class="ad-tip">加载中…</div>
    <div v-else-if="forbidden" class="ad-tip warn">无权限 —— 请用站长账号登录（需配置 ADMIN_UID）。</div>

    <template v-else>
      <div class="ad-bar">
        <span>待审 {{ items.length }} 条</span>
        <button class="ad-btn ghost" @click="load">刷新</button>
      </div>

      <div v-if="!items.length" class="ad-tip">暂无待审记录。</div>

      <table v-else class="ad-table">
        <thead>
          <tr><th>用户</th><th>金额</th><th>备注码</th><th>时间</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="it in items" :key="it.code">
            <td>{{ it.login }}</td>
            <td class="ad-amt">¥{{ it.amount }}</td>
            <td class="ad-code">{{ it.code }}</td>
            <td class="ad-time">{{ fmt(it.ts) }}</td>
            <td class="ad-ops">
              <button class="ad-btn ok" :disabled="busy === it.code" @click="review(it, 'approve')">通过</button>
              <button class="ad-btn no" :disabled="busy === it.code" @click="review(it, 'reject')">驳回</button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="msg" class="ad-msg">{{ msg }}</div>
      <div class="ad-hint">通过前请先在收款记录里核对：备注码 + 金额一致。</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";

type Item = { uid: string; login: string; amount: number; code: string; ts: number };

const items = ref<Item[]>([]);
const loading = ref(true);
const forbidden = ref(false);
const busy = ref("");
const msg = ref("");

function fmt(ts: number) {
    try { return new Date(ts).toLocaleString("zh-CN"); } catch { return String(ts); }
}

async function load() {
    loading.value = true;
    forbidden.value = false;
    msg.value = "";
    try {
        const resp = await fetch("/api/sponsor/admin/list");
        if (resp.status === 403 || resp.status === 401) { forbidden.value = true; return; }
        const data = await resp.json();
        items.value = data.items || [];
    } catch {
        msg.value = "加载失败";
    } finally {
        loading.value = false;
    }
}

async function review(it: Item, action: "approve" | "reject") {
    busy.value = it.code;
    msg.value = "";
    try {
        const resp = await fetch("/api/sponsor/admin/review", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: it.code, action }),
        });
        const r = await resp.json();
        if (r.ok) {
            msg.value = action === "approve"
                ? `已通过 ${it.login}，+${r.added ?? it.amount} 件`
                : `已驳回 ${it.login}`;
            items.value = items.value.filter(x => x.code !== it.code);
        } else {
            msg.value = r.reason || "操作失败";
        }
    } catch {
        msg.value = "网络错误";
    } finally {
        busy.value = "";
    }
}

onMounted(load);
</script>

<style scoped>
.admin-page {
    max-width: 760px;
    margin: 0 auto;
    padding: 100px 16px 60px;
    color: wheat;
    font-family: "ZhuoKai", system-ui, sans-serif;
}
.ad-title { font-size: 22px; margin-bottom: 18px; }
.ad-tip { color: rgba(255, 255, 255, 0.6); font-size: 14px; padding: 20px 0; }
.ad-tip.warn { color: #ff9a8a; }
.ad-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.75);
}
.ad-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
}
.ad-table th, .ad-table td {
    padding: 10px 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    text-align: left;
}
.ad-table th { color: rgba(255, 255, 255, 0.5); font-weight: 400; font-size: 12px; }
.ad-amt { color: #ffe08a; }
.ad-code { font-family: monospace; letter-spacing: 1px; color: #ffe08a; }
.ad-time { color: rgba(255, 255, 255, 0.5); font-size: 12px; }
.ad-ops { white-space: nowrap; }
.ad-btn {
    padding: 5px 14px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: rgba(255, 255, 255, 0.05);
    color: wheat;
    font-size: 13px;
    cursor: pointer;
    margin-right: 6px;
}
.ad-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ad-btn.ghost { color: rgba(255, 255, 255, 0.7); }
.ad-btn.ok { background: rgba(120, 200, 120, 0.18); border-color: rgba(120, 200, 120, 0.45); color: #b6e7b6; }
.ad-btn.no { background: rgba(255, 120, 120, 0.12); border-color: rgba(255, 120, 120, 0.4); color: #ffb0b0; }
.ad-msg { margin-top: 14px; font-size: 14px; color: #9be39b; }
.ad-hint { margin-top: 10px; font-size: 12px; color: rgba(255, 255, 255, 0.4); }
</style>

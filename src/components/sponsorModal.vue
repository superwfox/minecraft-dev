<template>
  <div v-if="showSponsorModal" class="sp-mask" @click.self="close">
    <div class="sp-card">
      <div class="sp-title">支持踏海 · 充值额度</div>

      <!-- 已到账 -->
      <template v-if="success">
        <div class="sp-done">✓ 到账成功，+{{ success.added }} 件</div>
        <button class="sp-btn" @click="close">完成</button>
      </template>

      <!-- 已提交，等待确认 -->
      <template v-else-if="submitted">
        <div class="sp-wait">
          <div class="sp-spinner"></div>
          <div class="sp-wait-text">已提交，等待管理员确认<br>通常 1-2 分钟自动到账，本窗口会提示</div>
        </div>
        <div class="sp-note">备注码 <b>{{ code }}</b> · 金额 ¥{{ amount }}</div>
        <div class="sp-close" @click="close">先关闭（到账后顶栏额度会刷新）</div>
      </template>

      <!-- 选档位 + 付款 -->
      <template v-else>
        <div class="sp-body">
          免费额度每月 1 号刷新；也可付款充值（1 元 = 1 件）。
          <b>付款时务必在备注里填下方专属码</b>，提交后管理员核对到账。
        </div>

        <div class="sp-tiers">
          <button v-for="t in SPONSOR_TIERS" :key="t.id"
                  class="sp-tier" :class="{ active: selectedTier === t.id }"
                  :disabled="requesting" @click="selectTier(t)">
            <span class="sp-tier-amt">{{ t.label }}</span>
            <span class="sp-tier-sub">{{ t.amount }} 件 · {{ t.badge }}</span>
          </button>
        </div>

        <template v-if="code">
          <div class="sp-pay">
            <div class="sp-methods">
              <span class="sp-method" :class="{ active: method === 'alipay' }" @click="method = 'alipay'; qrError = false">支付宝</span>
              <span class="sp-method" :class="{ active: method === 'wechat' }" @click="method = 'wechat'; qrError = false">微信</span>
            </div>
            <img class="sp-qr" :src="method === 'alipay' ? '/alipay.png' : '/wechatPay.jpg'" :alt="method"
                 @error="qrError = true"/>
            <div v-if="qrError" class="sp-qr-missing">收款码未配置</div>
            <div class="sp-amt-tip">付款金额 <b>¥{{ amount }}</b></div>
          </div>

          <div class="sp-code-box" @click="copyCode" title="点击复制">
            转账备注：<b class="sp-code">{{ code }}</b>
            <span class="sp-copy">{{ copied ? "已复制" : "复制" }}</span>
          </div>

          <button class="sp-btn" @click="onPaid">我已付款，提交待确认</button>
        </template>

        <div v-if="errMsg" class="sp-err">{{ errMsg }}</div>
        <div class="sp-close" @click="close">关闭</div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { showSponsorModal, authState, fetchMe, requestSponsor, SPONSOR_TIERS } from "../logic/auth";

const method = ref<"alipay" | "wechat">("alipay");
const selectedTier = ref("");
const code = ref("");
const amount = ref(0);
const requesting = ref(false);
const submitted = ref(false);
const success = ref<{ added: number } | null>(null);
const errMsg = ref("");
const copied = ref(false);
const qrError = ref(false);

let pollTimer: any = null;
let baseline = 0;

function reset() {
    selectedTier.value = "";
    code.value = "";
    amount.value = 0;
    requesting.value = false;
    submitted.value = false;
    success.value = null;
    errMsg.value = "";
    copied.value = false;
    qrError.value = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// 每次打开弹窗时重置
watch(showSponsorModal, (open) => { if (open) reset(); });

async function selectTier(t: { id: string; amount: number }) {
    if (requesting.value) return;
    requesting.value = true;
    errMsg.value = "";
    const r = await requestSponsor(t.id);
    requesting.value = false;
    if (r.ok && r.code) {
        selectedTier.value = t.id;
        code.value = r.code;
        amount.value = r.amount ?? t.amount;
    } else {
        errMsg.value = r.reason || "提交失败，请重试";
    }
}

async function copyCode() {
    try {
        await navigator.clipboard.writeText(code.value);
        copied.value = true;
        setTimeout(() => (copied.value = false), 1500);
    } catch { /* ignore */ }
}

function onPaid() {
    submitted.value = true;
    baseline = authState.quota?.paidBalance ?? 0;
    let ticks = 0;
    pollTimer = setInterval(async () => {
        ticks++;
        await fetchMe();
        const now = authState.quota?.paidBalance ?? 0;
        if (now > baseline) {
            success.value = { added: now - baseline };
            clearInterval(pollTimer); pollTimer = null;
        } else if (ticks >= 40) { // 约 3-4 分钟后停轮询（仍可手动刷新）
            clearInterval(pollTimer); pollTimer = null;
        }
    }, 5000);
}

function close() {
    showSponsorModal.value = false;
    reset();
}
</script>

<style scoped>
.sp-mask {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
}
.sp-card {
    width: 380px;
    max-width: 88vw;
    padding: 26px 26px 18px;
    border-radius: 18px;
    background: rgba(28, 24, 18, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5);
    color: wheat;
    text-align: center;
    font-family: "ZhuoKai", system-ui, sans-serif;
}
.sp-title { font-size: 21px; margin-bottom: 14px; }
.sp-body {
    font-size: 13.5px;
    line-height: 1.7;
    color: rgba(255, 255, 255, 0.78);
    margin-bottom: 18px;
    text-align: left;
}
.sp-body b { color: wheat; }

.sp-tiers { display: flex; gap: 12px; justify-content: center; }
.sp-tier {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 8px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: rgba(255, 255, 255, 0.04);
    color: wheat;
    cursor: pointer;
    transition: all 0.15s;
}
.sp-tier:hover:not(:disabled) { border-color: rgba(255, 255, 255, 0.4); }
.sp-tier.active { background: wheat; color: #1c1812; border-color: wheat; }
.sp-tier:disabled { opacity: 0.5; cursor: default; }
.sp-tier-amt { font-size: 18px; font-weight: 700; }
.sp-tier-sub { font-size: 11px; opacity: 0.8; }

.sp-pay { margin-top: 18px; }
.sp-methods { display: flex; gap: 8px; justify-content: center; margin-bottom: 10px; }
.sp-method {
    padding: 4px 16px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.7);
    font-size: 13px;
    cursor: pointer;
}
.sp-method.active { background: wheat; color: #000; border-color: wheat; }
.sp-qr {
    width: 180px;
    height: 180px;
    object-fit: contain;
    border-radius: 10px;
    background: #fff;
    padding: 6px;
}
.sp-qr-missing { font-size: 12px; color: #ff9a8a; margin-top: 6px; }
.sp-amt-tip { font-size: 13px; margin-top: 8px; color: rgba(255, 255, 255, 0.8); }
.sp-amt-tip b { color: #ffe08a; }

.sp-code-box {
    margin: 14px 0 4px;
    padding: 10px 12px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px dashed rgba(255, 224, 138, 0.5);
    font-size: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
}
.sp-code { color: #ffe08a; letter-spacing: 1px; font-size: 16px; }
.sp-copy { font-size: 11px; color: rgba(255, 255, 255, 0.5); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; padding: 1px 6px; }

.sp-btn {
    display: inline-block;
    margin-top: 16px;
    padding: 10px 28px;
    border: none;
    border-radius: 10px;
    background: wheat;
    color: #1c1812;
    font-size: 15px;
    cursor: pointer;
    transition: transform 0.15s, box-shadow 0.15s;
}
.sp-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(245, 222, 179, 0.35); }

.sp-wait { display: flex; flex-direction: column; align-items: center; gap: 14px; margin: 10px 0 16px; }
.sp-spinner {
    width: 28px;
    height: 28px;
    border: 3px solid rgba(255, 255, 255, 0.15);
    border-top-color: wheat;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.sp-wait-text { font-size: 14px; line-height: 1.6; color: rgba(255, 255, 255, 0.82); }
.sp-note { font-size: 12px; color: rgba(255, 255, 255, 0.55); }
.sp-note b { color: #ffe08a; }

.sp-done { font-size: 18px; color: #9be39b; margin: 18px 0; }
.sp-err { margin-top: 12px; font-size: 13px; color: #ff9a8a; }

.sp-close {
    margin-top: 14px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    user-select: none;
}
.sp-close:hover { color: rgba(255, 255, 255, 0.85); }
</style>

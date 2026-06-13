<template>
  <GlassCard>
    <div class="header">
      <div class="logo-wrap">
        <img class="header-icon" :src="logoSrc" alt="icon" @click="goHome">
        <!-- hover 浮层：剩余额度 + 订单兑换（仅登录后） -->
        <div v-if="authState.user" class="quota-pop">
          <div class="quota-line">剩余额度：<b>{{ authState.quota?.remaining ?? 0 }}</b></div>
          <div class="quota-sub" v-if="authState.quota">
            免费 {{ authState.quota.freeRemaining }} · 充值 {{ authState.quota.paidBalance }}
          </div>
          <div class="redeem-row">
            <input
              v-model="orderNo"
              class="redeem-input"
              placeholder="爱发电订单号"
              @keyup.enter="doRedeem"
            >
            <button class="redeem-btn" :disabled="redeeming" @click="doRedeem">
              {{ redeeming ? "..." : "兑换" }}
            </button>
          </div>
          <div v-if="redeemMsg" class="redeem-msg" :class="{ ok: redeemOk }">{{ redeemMsg }}</div>
          <div class="quota-logout" @click="doLogout">退出登录</div>
        </div>
      </div>
      <span class="header-title" @click="goHome">TAHAI</span>
    </div>

    <div class="center">
      <span>{{ centerText }}</span>
    </div>

    <div class="right">
      <span v-if="authState.loaded && !authState.user" class="link" @click="login">登录</span>
      <router-link class="link" to="/ide">IDE</router-link>
      <a class="link" href="https://minecraft-dev.pages.dev/" rel="noreferrer">文档</a>
      <a
        class="link qq-link"
        href="https://qm.qq.com/q/l2PcLa4nqU"
        target="_blank"
        rel="noopener noreferrer"
        title="加入 QQ 群"
        aria-label="QQ 群"
      >
        <svg class="qq-icon" viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">
          <path d="M824.8 613.2c-16-51.4-34.4-94.6-62.7-165.3C766.5 262.2 689.3 112 511.5 112 331.7 112 256.2 265.2 261 447.9c-28.4 70.8-46.7 113.7-62.7 165.3-34 109.5-23 154.8-14.6 155.8 18 2.2 70.1-82.4 70.1-82.4 0 49 25.2 112.9 79.8 159-26.4 8.1-85.7 29.9-71.6 53.8 11.4 19.3 196.2 12.3 249.5 6.3 53.3 6 238.1 13 249.5-6.3 14.1-23.8-45.3-45.7-71.6-53.8 54.6-46.1 79.8-110 79.8-159 0 0 52.1 84.6 70.1 82.4 8.5-1 19.5-46.3-14.5-155.8z"/>
        </svg>
      </a>
    </div>
  </GlassCard>
  <router-view/>
  <SponsorModal/>
</template>

<script setup lang="ts">
import {provide, ref, onMounted, computed} from "vue";
import GlassCard from "./components/glassCard.vue";
import SponsorModal from "./components/sponsorModal.vue";
import {useRouter} from "vue-router";
import {restoreSession, startSessionPersistence} from "./logic/sessionPersist";
import {authState, fetchMe, login, logout, redeemOrder, currentLogo} from "./logic/auth";

const router = useRouter();
const goHome = () => router.push("/");

const centerText = ref("");
provide("centerText", centerText);

const logoSrc = computed(() => currentLogo());

// 订单兑换
const orderNo = ref("");
const redeeming = ref(false);
const redeemMsg = ref("");
const redeemOk = ref(false);

async function doRedeem() {
  const no = orderNo.value.trim();
  if (!no || redeeming.value) return;
  redeeming.value = true;
  redeemMsg.value = "";
  try {
    const r = await redeemOrder(no);
    redeemOk.value = !!r.ok;
    redeemMsg.value = r.ok ? `兑换成功，+${r.added} 件` : (r.reason || "兑换失败");
    if (r.ok) orderNo.value = "";
  } finally {
    redeeming.value = false;
  }
}

function doLogout() {
  logout();
}

restoreSession();
onMounted(() => {
  startSessionPersistence();
  fetchMe();
});
</script>

<style>
@font-face {
  font-family: "ZhuoKai";
  src: url("/jiangxizhuokai_full.woff2") format("woff2");
  font-weight: normal;
  font-style: normal;
  font-display: swap;
  unicode-range: U+0041, U+0048, U+0049, U+0054, U+4E00-9FFF, U+3000-303F, U+FF00-FFEF;
}

@font-face {
  font-family: "Monaco";
  src: url("font/Monaco.ttf") format("truetype");
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background: #000;
  font-family: "Monaco", "ZhuoKai", system-ui, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
}

.header-title {
  font-family: "ZhuoKai", sans-serif;
  cursor: pointer;
}

/* QQ 群入口：内联 svg，继承 .link 的白色 currentColor */
.qq-link {
  display: inline-flex;
  align-items: center;
}

.qq-icon {
  width: 20px;
  height: 20px;
  display: block;
}

/* logo 与 hover 浮层 */
.logo-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.quota-pop {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 8px;
  width: 220px;
  padding: 14px 14px 10px;
  border-radius: 14px;
  background: rgba(28, 24, 18, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
  color: wheat;
  font-size: 14px;
  z-index: 60;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-4px);
  transition: opacity 0.15s, transform 0.15s, visibility 0.15s;
}

/* 用一段透明区域作为 hover 桥，避免移动到浮层时断开 */
.quota-pop::before {
  content: "";
  position: absolute;
  top: -8px;
  left: 0;
  right: 0;
  height: 8px;
}

.logo-wrap:hover .quota-pop {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}

.quota-line {
  font-size: 15px;
}

.quota-line b {
  color: #ffe08a;
  font-size: 17px;
}

.quota-sub {
  margin-top: 2px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.redeem-row {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}

.redeem-input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: wheat;
  font-size: 13px;
  outline: none;
}

.redeem-input::placeholder {
  color: rgba(255, 255, 255, 0.35);
}

.redeem-btn {
  padding: 6px 12px;
  border-radius: 8px;
  border: none;
  background: wheat;
  color: #1c1812;
  font-size: 13px;
  cursor: pointer;
}

.redeem-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.redeem-msg {
  margin-top: 8px;
  font-size: 12px;
  color: #ff9a8a;
}

.redeem-msg.ok {
  color: #9be39b;
}

.quota-logout {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  text-align: right;
}

.quota-logout:hover {
  color: rgba(255, 255, 255, 0.85);
}

* {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}
*::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
*::-webkit-scrollbar-track {
  background: transparent;
}
*::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  transition: background 0.2s;
}
*::-webkit-scrollbar-thumb:hover {
  background: wheat;
}
*::-webkit-scrollbar-corner {
  background: transparent;
}
</style>

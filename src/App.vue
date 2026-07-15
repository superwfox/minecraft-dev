<template>
  <GlassCard>
    <div class="header">
      <div
        ref="logoWrap"
        class="logo-wrap"
        @pointerenter="openQuota"
        @pointerleave="scheduleQuotaClose"
      >
        <img class="header-icon" :src="logoSrc" alt="icon" @click="goHome">
      </div>
      <span class="header-title" @click="goHome">tahai</span>
    </div>

    <div class="center">
      <TopNav/>
    </div>

    <div class="right">
      <span v-if="authState.loaded && !authState.user" class="link" @click="login">登录</span>
      <a class="link" href="https://minecraft-dev.pages.dev/" rel="noreferrer">DOC</a>
      <a
        class="link qq-link"
        href="https://qm.qq.com/q/l2PcLa4nqU"
        target="_blank"
        rel="noopener noreferrer"
        title="qq"
        aria-label="qq"
      >
        qq
      </a>
    </div>
  </GlassCard>
  <Teleport to="body">
    <div
      v-if="authState.user"
      class="quota-pop"
      :class="{ open: quotaOpen }"
      :style="quotaPopStyle"
      @pointerenter="cancelQuotaClose"
      @pointerleave="scheduleQuotaClose"
    >
      <div class="quota-line">剩余额度：<b>{{ authState.quota?.remaining ?? 0 }}</b></div>
      <div class="quota-sub" v-if="authState.quota">
        免费 {{ authState.quota.freeRemaining }} · 充值 {{ authState.quota.paidBalance }}
      </div>
      <button class="recharge-btn" @click="openSponsor">充值额度</button>
      <div class="quota-logout" @click="doLogout">退出登录</div>
    </div>
  </Teleport>
  <router-view/>
  <SponsorModal/>
</template>

<script setup lang="ts">
import {provide, ref, onMounted, onBeforeUnmount, computed} from "vue";
import GlassCard from "./components/glassCard.vue";
import SponsorModal from "./components/sponsorModal.vue";
import TopNav from "./components/TopNav.vue";
import {useRouter} from "vue-router";
import {restoreSession, startSessionPersistence} from "./logic/sessionPersist";
import {authState, fetchMe, login, logout, currentLogo, showSponsorModal} from "./logic/auth";

const router = useRouter();
const goHome = () => router.push("/");

const centerText = ref("");
provide("centerText", centerText);

const logoSrc = computed(() => currentLogo());
const logoWrap = ref<HTMLElement | null>(null);
const quotaOpen = ref(false);
const quotaPosition = ref({ top: 0, left: 0 });
const quotaPopStyle = computed(() => ({
  top: `${quotaPosition.value.top}px`,
  left: `${quotaPosition.value.left}px`,
}));

const QUOTA_WIDTH = 220;
const QUOTA_GAP = 8;
const VIEWPORT_GUTTER = 12;
let quotaCloseTimer: number | undefined;

function updateQuotaPosition() {
  const anchor = logoWrap.value;
  if (!anchor) return;

  const rect = anchor.getBoundingClientRect();
  const width = Math.min(QUOTA_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2);
  const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - width - VIEWPORT_GUTTER);
  quotaPosition.value = {
    top: rect.bottom + QUOTA_GAP,
    left: Math.min(Math.max(rect.left, VIEWPORT_GUTTER), maxLeft),
  };
}

function cancelQuotaClose() {
  if (quotaCloseTimer === undefined) return;
  window.clearTimeout(quotaCloseTimer);
  quotaCloseTimer = undefined;
}

function openQuota() {
  if (!authState.user) return;
  cancelQuotaClose();
  updateQuotaPosition();
  quotaOpen.value = true;
}

function scheduleQuotaClose() {
  cancelQuotaClose();
  quotaCloseTimer = window.setTimeout(() => {
    quotaOpen.value = false;
    quotaCloseTimer = undefined;
  }, 180);
}

function openSponsor() {
  cancelQuotaClose();
  quotaOpen.value = false;
  showSponsorModal.value = true;
}

function doLogout() {
  cancelQuotaClose();
  quotaOpen.value = false;
  logout();
}

restoreSession();
onMounted(() => {
  startSessionPersistence();
  fetchMe();
  window.addEventListener("resize", updateQuotaPosition);
});

onBeforeUnmount(() => {
  cancelQuotaClose();
  window.removeEventListener("resize", updateQuotaPosition);
});
</script>

<style>
@font-face {
  font-family: "Jiangxizhuokai";
  src: url("/jiangxizhuokai_full.woff2") format("woff2");
  font-weight: normal;
  font-style: normal;
  font-display: swap;
  /* 全量字体，不再限制码位范围（原 unicode-range 是 subset 时代的残留白名单） */
}

/* 兼容仍使用旧 family 名称的现有组件，二者复用同一字体资源。 */
@font-face {
  font-family: "ZhuoKai";
  src: url("/jiangxizhuokai_full.woff2") format("woff2");
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: "Monaco";
  src: url("font/Monaco.ttf") format("truetype");
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: "MinecrafterAlt";
  src: url("/minecrafter-alt.woff2") format("woff2");
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: "MinecrafterReg";
  src: url("/minecrafter-reg.woff2") format("woff2");
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

:root {
  --surface-0: #000000;
  --surface-1: #040402;
  --surface-2: #1a1a18;
  --surface-3: #262626;
  --line: #474743;
  --line-strong: #8c8c8c;
  --oak: #c6b07d;
  --oak-hover: #d5c9ac;
  --oak-soft: rgba(198, 176, 125, 0.1);
  --wheat: #d1c8b6;
  --cyan: #438091;
  --text-primary: #d1c8b6;
  --text-secondary: rgba(209, 200, 182, 0.68);
  --text-muted: rgba(209, 200, 182, 0.42);
  /* Compatibility aliases for components that still use the old token names. */
  --oak-deep: var(--surface-1);
  --oak-surface: var(--surface-2);
  --deepslate: var(--surface-2);
  --oak-border: var(--line);
  --oak-highlight: var(--line-strong);
}

html,
body,
#app {
  min-height: 100%;
  background: #000;
  color: var(--text-primary);
}

body {
  background: #000;
  font-family: "Monaco", "Jiangxizhuokai", system-ui, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
}

.header-title {
  font-family: "MinecrafterAlt", sans-serif;
  font-size: 26px;
  letter-spacing: 0;
  color: #d1c8b6;
  cursor: pointer;
}

.right .link {
  font-family: "MinecrafterAlt", sans-serif;
  font-size: 14px;
  letter-spacing: 0;
}

.qq-link {
  display: inline-flex;
  align-items: center;
}

/* logo 与 hover 浮层 */
.logo-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.quota-pop {
  position: fixed;
  width: min(220px, calc(100vw - 24px));
  padding: 14px 14px 10px;
  border-radius: 14px;
  background: rgba(8, 9, 10, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 16px 42px rgba(0, 0, 0, 0.58);
  color: var(--text-primary);
  font-size: 14px;
  z-index: 90;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
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

.quota-pop.open {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateY(0);
}

.quota-line {
  font-size: 15px;
}

.quota-line b {
  color: var(--line-strong);
  font-size: 17px;
}

.quota-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-muted);
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
  background: rgba(255, 255, 255, 0.045);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}

.redeem-input::placeholder {
  color: var(--text-muted);
}

.redeem-btn {
  padding: 6px 12px;
  border-radius: 8px;
  border: none;
  background: var(--oak);
  color: var(--surface-1);
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
  color: var(--line-strong);
}

.redeem-msg.ok {
  color: var(--line);
}

.recharge-btn {
  margin-top: 12px;
  width: 100%;
  padding: 8px 0;
  border-radius: 8px;
  border: none;
  background: var(--oak);
  color: var(--surface-1);
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.recharge-btn:hover {
  background: var(--oak-hover);
}

.quota-logout {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  text-align: right;
}

.quota-logout:hover {
  color: var(--text-primary);
}

* {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}
*::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
*::-webkit-scrollbar-track {
  background: transparent;
}
*::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 3px;
  transition: background 0.2s;
}
*::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.38);
}
*::-webkit-scrollbar-corner {
  background: transparent;
}
</style>

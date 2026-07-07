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
          <button class="recharge-btn" @click="openSponsor">充值额度</button>
          <div class="quota-logout" @click="doLogout">退出登录</div>
        </div>
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
  <router-view/>
  <SponsorModal/>
</template>

<script setup lang="ts">
import {provide, ref, onMounted, computed} from "vue";
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

function openSponsor() {
  showSponsorModal.value = true;
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
  /* 全量字体，不再限制码位范围（原 unicode-range 是 subset 时代的残留白名单） */
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

body {
  background: #000;
  font-family: "Monaco", "ZhuoKai", system-ui, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
}

.header-title {
  font-family: "ZhuoKai", sans-serif;
  cursor: pointer;
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

.recharge-btn {
  margin-top: 12px;
  width: 100%;
  padding: 8px 0;
  border-radius: 8px;
  border: none;
  background: wheat;
  color: #1c1812;
  font-size: 14px;
  cursor: pointer;
  transition: opacity 0.15s;
}
.recharge-btn:hover {
  opacity: 0.88;
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

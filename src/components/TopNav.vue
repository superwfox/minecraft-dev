<template>
  <nav class="topnav">
    <div class="topnav-tabs">
      <router-link to="/ide" class="tab" :class="{ active: act('ide'), busy: ideBusy }">ide</router-link>
      <router-link to="/chat" class="tab" :class="{ active: act('chat'), busy: chatBusy }">chat</router-link>
      <router-link to="/skills" class="tab" :class="{ active: act('skills') }">skill</router-link>
    </div>
    <div class="topnav-status">{{ statusText }}</div>
  </nav>
</template>

<script setup lang="ts">
import { computed, inject } from "vue";
import type { Ref } from "vue";
import { useRoute } from "vue-router";
import { genTask } from "../logic/generateState";
import { useIDEStore } from "../ide/composables/useIDEStore";
import { useIDEChat } from "../ide/composables/useIDEChat";

const route = useRoute();
const centerText = inject<Ref<string>>("centerText");

function act(which: "ide" | "chat" | "skills"): boolean {
    const p = route.path;
    if (which === "ide") return p === "/ide" || p.startsWith("/ide/");
    if (which === "chat") return p === "/chat";
    return p === "/skills";
}

// CHAT 运行态：generateState 的 busy 阶段（排除 idle/done/error/awaiting_input）
const BUSY_PHASES = new Set([
    "planning", "clarifying", "grading", "confirming", "generating",
    "verifying", "uploading", "building", "polling", "fixing",
]);
const chatBusy = computed(() => BUSY_PHASES.has(genTask.phase));

// IDE 运行态：加载任务 / IDE 内 AI 流式
const ideStore = useIDEStore();
const ideChat = useIDEChat();
const ideBusy = computed(() => ideStore.state.loading || ideChat.state.streaming);

// busy 时把 centerText（如「正在分析需求…」）降级为切换栏下方小字
const statusText = computed(() => (chatBusy.value || ideBusy.value) ? (centerText?.value || "") : "");
</script>

<style scoped>
.topnav {
    position: relative;
    font-family: "MinecrafterAlt", sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 54px;
    text-shadow: none;
}

.topnav-tabs {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 32px;
}

.tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    letter-spacing: 0;
    text-transform: lowercase;
    position: relative;
    color: rgba(209, 200, 182, 0.48);
    text-decoration: none;
    height: 32px;
    line-height: 1;
    padding: 0 14px;
    transition: color 0.16s ease;
    cursor: pointer;
}

.tab::after {
    content: "";
    position: absolute;
    right: 14px;
    bottom: 1px;
    left: 14px;
    height: 1px;
    background: #c6b07d;
    opacity: 0;
    transform: scaleX(0.35);
    transition: opacity 0.16s ease, transform 0.16s ease;
}

.tab:hover { color: rgba(244, 241, 236, 0.82); }

.tab:focus-visible {
    outline: 1px solid rgba(255, 255, 255, 0.42);
    outline-offset: 3px;
}

.tab.active {
    background: transparent;
    color: #d1c8b6;
}

.tab.active::after {
    opacity: 1;
    transform: scaleX(1);
}

.tab.busy {
    color: #d5c9ac;
}

.tab.busy::after {
    opacity: 0.72;
    transform: scaleX(1);
    animation: busyLine 1.4s ease-in-out infinite;
}

@keyframes busyLine {
    0%, 100% { opacity: 0.34; }
    50% { opacity: 0.9; }
}

.topnav-status {
    position: absolute;
    top: calc(50% + 18px);
    left: 50%;
    transform: translateX(-50%);
    width: 100%;
    max-width: 220px;
    height: 13px;
    line-height: 13px;
    font-family: "Monaco", "ZhuoKai", sans-serif;
    font-size: 10px;
    letter-spacing: 0;
    color: rgba(225, 225, 221, 0.48);
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

@media (prefers-reduced-motion: reduce) {
    .tab.busy::after { animation: none; opacity: 0.72; }
}

@media (max-width: 820px) {
    .topnav { height: 46px; }
    .topnav-tabs { gap: 2px; }
    .tab {
        padding-inline: 8px;
        font-size: 13px;
    }
    .topnav-status {
        top: calc(50% + 16px);
        max-width: 150px;
        font-size: 9px;
    }
}
</style>

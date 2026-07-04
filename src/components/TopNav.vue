<template>
  <nav class="topnav">
    <div class="topnav-tabs">
      <router-link to="/ide" class="tab" :class="{ active: act('ide'), busy: ideBusy }">IDE</router-link>
      <router-link to="/chat" class="tab" :class="{ active: act('chat'), busy: chatBusy }">CHAT</router-link>
      <router-link to="/skills" class="tab" :class="{ active: act('skills') }">SKILL</router-link>
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
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    text-shadow: none;
}

.topnav-tabs {
    display: flex;
    align-items: center;
    gap: 6px;
}

.tab {
    font-family: "ZhuoKai", sans-serif;
    font-size: 15px;
    letter-spacing: 0.06em;
    color: rgba(255, 255, 255, 0.62);
    text-decoration: none;
    padding: 4px 14px;
    border-radius: 6px; /* 圆角矩形（原 10px 在矮元素上偏药丸感） */
    border: 1px solid transparent;
    transition: color 0.2s, background 0.2s, border-color 0.2s;
    cursor: pointer;
}

.tab:hover { color: #fff; }

/* 当前所在页：略带底色的圆角矩形 */
.tab.active {
    background: rgba(245, 222, 179, 0.14);
    color: wheat;
}

/* 正在请求/编译中：主题色边框 + 呼吸灯闪烁（淡入淡出） */
.tab.busy {
    animation: tabBreathe 1.4s ease-in-out infinite;
}

@keyframes tabBreathe {
    0%, 100% {
        border-color: rgba(245, 222, 179, 0.25);
        box-shadow: 0 0 0 0 rgba(245, 222, 179, 0);
    }
    50% {
        border-color: rgba(245, 222, 179, 0.95);
        box-shadow: 0 0 9px 0 rgba(245, 222, 179, 0.38);
    }
}

.topnav-status {
    height: 13px;
    line-height: 13px;
    font-size: 11px;
    letter-spacing: 0.04em;
    color: rgba(245, 222, 179, 0.6);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 220px;
}

@media (prefers-reduced-motion: reduce) {
    .tab.busy { animation: none; border-color: rgba(245, 222, 179, 0.7); }
}
</style>

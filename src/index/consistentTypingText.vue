<template>
  <div class="typing-wrap">
    <span class="typing-text">{{ display }}</span>
    <span class="typing-cursor">|</span>
  </div>
</template>

<script setup lang="ts">
import {ref, onMounted, onBeforeUnmount} from "vue";

const texts = [
  "为 Minecraft 开发者而生",
  "AI 驱动的开发指导",
  "让插件开发更简单",
  "踏海 · MC DevTool",
  "PAPER | BUKKIT | SPIGOT",
  "全版本支持"
];

const display = ref("");
let timer = 0;
let idx = 0;
let charIdx = 0;
let deleting = false;
let pausing = false;

const TYPE_MS = 100;
const DELETE_MS = 50;
const PAUSE_AFTER_TYPE = 1800;
const PAUSE_AFTER_DELETE = 400;

function tick() {
  const current = texts[idx];

  if (pausing) return;

  if (!deleting) {
    charIdx++;
    display.value = current.slice(0, charIdx);
    if (charIdx >= current.length) {
      pausing = true;
      setTimeout(() => {
        pausing = false;
        deleting = true;
      }, PAUSE_AFTER_TYPE);
    }
  } else {
    charIdx--;
    display.value = current.slice(0, charIdx);
    if (charIdx <= 0) {
      pausing = true;
      deleting = false;
      idx = (idx + 1) % texts.length;
      setTimeout(() => {
        pausing = false;
      }, PAUSE_AFTER_DELETE);
    }
  }
}

onMounted(() => {
  timer = window.setInterval(() => tick(), deleting ? DELETE_MS : TYPE_MS);
  // 用动态间隔替代固定 interval
  clearInterval(timer);

  function schedule() {
    timer = window.setTimeout(() => {
      tick();
      schedule();
    }, deleting ? DELETE_MS : TYPE_MS);
  }

  schedule();
});

onBeforeUnmount(() => clearTimeout(timer));
</script>

<style scoped>
.typing-wrap {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 0;
  font-size: 58px;
  color: white;
  text-shadow: 0 0 8px wheat;
  font-family: system-ui, sans-serif;
  white-space: nowrap;
  user-select: none;
  pointer-events: none;
}

.typing-cursor {
  animation: blink 1s step-end infinite;
  font-weight: 100;
  opacity: 0.8;
}

@keyframes blink {
  0%, 100% {
    opacity: 0.8;
  }
  50% {
    opacity: 0;
  }
}
</style>

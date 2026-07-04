<template>
  <div class="tm" role="status" aria-live="polite">
    <span class="tm-word" :key="word">{{ word }}</span>
    <span class="tm-dots"><i></i><i></i><i></i></span>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";

// 缓解等待焦虑：非流式后没有逐字思考流，用单色跑马灯扫过这些状态词表示「仍在工作」。
const WORDS = ["WORKING", "THINKING", "DELIBERATING", "FOSTERING", "LEAFING"];
const word = ref(WORDS[0]);
let i = 0;
let timer: any = null;

onMounted(() => {
  timer = setInterval(() => {
    i = (i + 1) % WORDS.length;
    word.value = WORDS[i];
  }, 2200);
});
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.tm {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

/* 单色跑马灯：一束高光在字母上反复扫过（background-clip: text） */
.tm-word {
  font-family: "Monaco", "Menlo", monospace;
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 3px;
  background: linear-gradient(
    100deg,
    rgba(255, 255, 255, 0.22) 32%,
    rgba(255, 255, 255, 0.95) 50%,
    rgba(255, 255, 255, 0.22) 68%
  );
  background-size: 220% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  animation: tm-sweep 1.8s linear infinite, tm-in 0.42s ease;
}

@keyframes tm-sweep {
  0% { background-position: 180% 0; }
  100% { background-position: -80% 0; }
}
@keyframes tm-in {
  from { opacity: 0; transform: translateY(3px); filter: blur(2px); }
  to { opacity: 1; transform: none; filter: none; }
}

.tm-dots { display: inline-flex; gap: 3px; }
.tm-dots i {
  width: 4px;
  height: 4px;
  border-radius: 1px; /* 圆角矩形，非圆点 */
  background: rgba(255, 255, 255, 0.55);
  animation: tm-blink 1.4s infinite;
}
.tm-dots i:nth-child(2) { animation-delay: 0.18s; }
.tm-dots i:nth-child(3) { animation-delay: 0.36s; }
@keyframes tm-blink {
  0%, 100% { opacity: 0.18; }
  50% { opacity: 1; }
}
</style>

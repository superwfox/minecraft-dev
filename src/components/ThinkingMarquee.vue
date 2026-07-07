<template>
  <div class="tm" role="status" aria-live="polite">
    <Transition name="tm-fade" mode="out-in">
      <span class="tm-word" :key="word" :data-text="word + '…'">{{ word }}…</span>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";

// 缓解等待焦虑：非流式后没有逐字思考流，用单色高光扫过这些状态词表示「仍在工作」。
// 每个词高光扫过 3 次后停住（CSS iteration-count: 3），静置片刻再淡出切换 —— 避免高光刚露头就被下一个词打断。
const WORDS = ["working", "thinking", "deliberating", "fostering", "leafing"];
const word = ref(WORDS[0]);
let i = 0;
let timer: any = null;

// 单次扫光 1.6s × 3 = 4.8s；再留 0.9s 静置 → 5.7s 切换（此时高光早已扫完，切换点干净）
onMounted(() => {
  timer = setInterval(() => {
    i = (i + 1) % WORDS.length;
    word.value = WORDS[i];
  }, 5700);
});
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.tm {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
}

.tm-word {
  position: relative;
  font-family: "MinecrafterReg", "Monaco", "Menlo", monospace;
  font-weight: 400;
  font-size: 15px;
  letter-spacing: 2px;
  color: rgba(255, 255, 255, 0.72); /* 静态可读底色 */
  white-space: nowrap;
}

/* 高光层：同一文字，一束亮带扫过；透明底 → 不扫时完全隐形，只剩底色。扫 3 次后停。 */
.tm-word::after {
  content: attr(data-text);
  position: absolute;
  inset: 0;
  background: linear-gradient(
    100deg,
    transparent 42%,
    rgba(255, 255, 255, 0.95) 50%,
    transparent 58%
  );
  background-size: 240% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  animation: tm-shine 1.6s linear 3;
}

@keyframes tm-shine {
  0% { background-position: 200% 0; }
  100% { background-position: -100% 0; }
}

/* 词间淡入淡出（out-in：旧词淡出后新词淡入，无硬切） */
.tm-fade-enter-active,
.tm-fade-leave-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.tm-fade-enter-from { opacity: 0; transform: translateY(4px); }
.tm-fade-leave-to { opacity: 0; transform: translateY(-4px); }
</style>

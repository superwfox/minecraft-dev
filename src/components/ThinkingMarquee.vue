<template>
  <div ref="rootEl" class="tm" :class="`tm-${variant}`" role="status" aria-live="polite" aria-atomic="true">
    <Transition name="tm-fade" mode="out-in">
      <span ref="wordEl" class="tm-word" :key="word" :data-text="word + '…'"
            :style="heroWordStyle">{{ word }}…</span>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import {computed, nextTick, onMounted, onUnmounted, ref, watch} from "vue";

const props = withDefaults(defineProps<{ variant?: "hero" | "compact" }>(), { variant: "compact" });

// 缓解等待焦虑：非流式后没有逐字思考流，用单色高光扫过这些状态词表示「仍在工作」。
// 每个词高光扫过 3 次后停住（CSS iteration-count: 3），静置片刻再淡出切换 —— 避免高光刚露头就被下一个词打断。
const WORDS = ["working", "thinking", "deliberating", "fostering", "leafing"];
const word = ref(WORDS[0]);
const rootEl = ref<HTMLElement | null>(null);
const wordEl = ref<HTMLElement | null>(null);
const heroFontSize = ref(68);
const heroWordStyle = computed(() => props.variant === "hero"
  ? {fontSize: `${heroFontSize.value}px`}
  : undefined
);
let i = 0;
let timer: any = null;
let resizeObserver: ResizeObserver | null = null;

async function fitHeroWord() {
  if (props.variant !== "hero") return;
  await nextTick();

  const root = rootEl.value;
  const el = wordEl.value;
  if (!root || !el) return;

  const rootStyle = getComputedStyle(root);
  const availableWidth = root.clientWidth
    - parseFloat(rootStyle.paddingLeft)
    - parseFloat(rootStyle.paddingRight)
    - 6;
  const availableHeight = root.clientHeight
    - parseFloat(rootStyle.paddingTop)
    - parseFloat(rootStyle.paddingBottom)
    - 4;
  const rect = el.getBoundingClientRect();
  const currentSize = parseFloat(getComputedStyle(el).fontSize);
  if (availableWidth <= 0 || availableHeight <= 0 || rect.width <= 0 || rect.height <= 0 || currentSize <= 0) return;

  const scale = Math.min(availableWidth / rect.width, availableHeight / rect.height);
  const nextSize = Math.max(32, Math.min(112, currentSize * scale));
  if (Math.abs(nextSize - heroFontSize.value) > 0.1) {
    heroFontSize.value = Math.floor(nextSize * 10) / 10;
  }
}

// Hero 以四分之一速度播放：6.4s × 3 + 3.6s 静置 = 22.8s；compact 保持原节奏。
onMounted(() => {
  timer = setInterval(() => {
    i = (i + 1) % WORDS.length;
    word.value = WORDS[i];
  }, props.variant === "hero" ? 22800 : 5700);

  if (props.variant === "hero" && rootEl.value) {
    resizeObserver = new ResizeObserver(() => { void fitHeroWord(); });
    resizeObserver.observe(rootEl.value);
    void fitHeroWord();
    void document.fonts?.ready.then(() => fitHeroWord());
  }
});
watch(word, () => { void fitHeroWord(); });
onUnmounted(() => {
  if (timer) clearInterval(timer);
  resizeObserver?.disconnect();
});
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
  font-weight: 500;
  font-size: 15px;
  letter-spacing: 0;
  color: var(--text-secondary, #abb6ba);
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
    var(--oak-highlight, #AF9876) 50%,
    transparent 58%
  );
  background-size: 240% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  animation: tm-shine 1.6s linear 3;
}

.tm-hero {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 4px 6px;
  box-sizing: border-box;
  justify-content: center;
}
.tm-hero .tm-word {
  display: inline-block;
  line-height: 1.08;
  letter-spacing: -0.035em;
}
.tm-hero .tm-word::after { animation-duration: 6.4s; }
.tm-compact .tm-word { font-size: 14px; letter-spacing: 0; }

@keyframes tm-shine {
  0% { background-position: 200% 0; }
  100% { background-position: -100% 0; }
}

/* 词间淡入淡出（out-in：旧词淡出后新词淡入，无硬切） */
.tm-fade-enter-active,
.tm-fade-leave-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.tm-fade-enter-from { opacity: 0; transform: translateY(4px); }
.tm-fade-leave-to { opacity: 0; transform: translateY(-4px); }

@media (max-width: 760px) {
  .tm-hero { padding-inline: 4px; }
}
@media (prefers-reduced-motion: reduce) {
  .tm-word::after { animation: none; }
  .tm-fade-enter-active, .tm-fade-leave-active { transition: none; }
}
</style>

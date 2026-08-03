<template>
  <div class="tm" :class="`tm-${variant}`" role="status" aria-live="polite" aria-atomic="true">
    <Transition name="tm-fade" mode="out-in" @after-enter="fitHeroWord">
      <span ref="wordEl" class="tm-word" :key="word" :data-text="word + '…'"
            :style="heroWordStyle">{{ word }}…</span>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import {computed, nextTick, onMounted, onUnmounted, ref, watch} from "vue";

const props = withDefaults(defineProps<{ variant?: "hero" | "compact" }>(), { variant: "compact" });
const emit = defineEmits<{
  (event: "size-change", size: {width: number; height: number}): void;
}>();

// 缓解等待焦虑：非流式后没有逐字思考流，用单色高光扫过这些状态词表示「仍在工作」。
// 每个词总共停留 5s；Hero 使用更大的字号，并把实测尺寸通知外层聊天框。
const WORDS = ["working", "thinking", "deliberating", "fostering", "leafing"];
const WORD_INTERVAL_MS = 5000;
const HERO_FONT_SIZE = 136;
const HERO_MIN_FONT_SIZE = 32;
const HERO_BOX_INLINE_PADDING = 64;
const HERO_BOX_BLOCK_PADDING = 32;
const word = ref(WORDS[0]);
const wordEl = ref<HTMLElement | null>(null);
const heroFontSize = ref(HERO_FONT_SIZE);
const heroWordStyle = computed(() => props.variant === "hero"
  ? {fontSize: `${heroFontSize.value}px`}
  : undefined
);
let i = 0;
let timer: any = null;

async function fitHeroWord() {
  if (props.variant !== "hero") return;

  // 每次换词先恢复目标字号，再只在当前视口装不下时按比例缩小。
  heroFontSize.value = HERO_FONT_SIZE;
  await nextTick();

  const el = wordEl.value;
  if (!el) return;

  const maxBoxWidth = Math.max(280, Math.min(1280, window.innerWidth - 24));
  const maxWordWidth = maxBoxWidth - HERO_BOX_INLINE_PADDING;
  const naturalRect = el.getBoundingClientRect();
  if (naturalRect.width > maxWordWidth) {
    heroFontSize.value = Math.max(
      HERO_MIN_FONT_SIZE,
      Math.floor(HERO_FONT_SIZE * maxWordWidth / naturalRect.width * 10) / 10,
    );
    await nextTick();
  }

  const fittedRect = el.getBoundingClientRect();
  emit("size-change", {
    width: Math.min(maxBoxWidth, Math.ceil(fittedRect.width + HERO_BOX_INLINE_PADDING)),
    height: Math.ceil(fittedRect.height + HERO_BOX_BLOCK_PADDING),
  });
}

onMounted(() => {
  timer = setInterval(() => {
    i = (i + 1) % WORDS.length;
    word.value = WORDS[i];
  }, WORD_INTERVAL_MS);

  if (props.variant === "hero") {
    void fitHeroWord();
    void document.fonts?.ready.then(() => fitHeroWord());
    window.addEventListener("resize", fitHeroWord);
  }
});
watch(word, () => { void fitHeroWord(); });
onUnmounted(() => {
  if (timer) clearInterval(timer);
  window.removeEventListener("resize", fitHeroWord);
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
  animation: tm-shine 2.8s linear 3;
}

.tm-hero {
  width: auto;
  height: auto;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  justify-content: center;
}
.tm-hero .tm-word {
  display: inline-block;
  line-height: 1.08;
  letter-spacing: -0.035em;
}
.tm-compact .tm-word { font-size: 14px; letter-spacing: 0; }

@keyframes tm-shine {
  0% { background-position: 200% 0; }
  100% { background-position: -100% 0; }
}

/* 词间淡入淡出（out-in：旧词淡出后新词淡入，无硬切） */
.tm-fade-enter-active,
.tm-fade-leave-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.tm-fade-enter-from { opacity: 0; transform: translateY(4px); }
.tm-fade-leave-to { opacity: 0; transform: translateY(-4px); }

@media (prefers-reduced-motion: reduce) {
  .tm-word::after { animation: none; }
  .tm-fade-enter-active, .tm-fade-leave-active { transition: none; }
}
</style>

<template>
  <main class="home-page">
    <section ref="scene" class="home-parallax" aria-labelledby="home-title">
      <div ref="stage" class="home-stage">
        <div class="home-landscape" aria-hidden="true">
          <div v-for="layer in layers" :key="layer.name" class="home-layer" :class="`home-layer-${layer.name}`">
            <img
              :src="layer.src"
              alt=""
              width="1672"
              height="941"
              decoding="async"
              :fetchpriority="layer.name === 'far' ? 'high' : 'auto'"
              draggable="false"
            />
          </div>
        </div>
        <div class="home-atmosphere" aria-hidden="true"/>

        <div class="home-heading">
          <p class="home-eyebrow">踏海 · MC DevTool</p>
          <h1 id="home-title">让想法，<br>层层成形。</h1>
        </div>

        <div class="home-scroll-hint" aria-hidden="true">
          <span>向下滚动</span>
          <ArrowDown :size="18" :stroke-width="1.4"/>
        </div>
      </div>
    </section>

    <section
      v-for="content in contentSections"
      :key="content.id"
      ref="contentScenes"
      class="home-block-scene"
      :class="`scene-${content.id}`"
      :aria-labelledby="`home-${content.id}-title`"
    >
      <div class="home-block-stage">
        <div class="home-block-shapes" aria-hidden="true">
          <div class="home-block-plane plane-far"><span class="shape-one"/><span class="shape-two"/></div>
          <div class="home-block-plane plane-middle"><span class="shape-one"/><span class="shape-two"/></div>
          <div class="home-block-plane plane-near"><span class="shape-one"/><span class="shape-two"/></div>
        </div>
        <div class="home-block-panel">
          <p class="home-block-label"><component :is="content.icon" :size="22" :stroke-width="1.4" aria-hidden="true"/>{{ content.label }}</p>
          <h2 :id="`home-${content.id}-title`">{{ content.title[0] }}<br>{{ content.title[1] }}</h2>
          <p class="home-block-description">{{ content.description }}</p>
          <a v-lattice class="home-block-action" :href="content.href" target="_blank" rel="noopener noreferrer">
            {{ content.action }}
            <ArrowUpRight :size="18" aria-hidden="true"/>
          </a>
        </div>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import {onBeforeUnmount, onMounted, ref} from "vue";
import {ArrowDown, ArrowUpRight, BookOpen, MessagesSquare} from "lucide-vue-next";

const scene = ref<HTMLElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const contentScenes = ref<HTMLElement[]>([]);
const layers = [
  {name: "far", src: "/home-valley/far-v1.webp"},
  {name: "middle", src: "/home-valley/middle-v1.webp"},
  {name: "near", src: "/home-valley/near-v1.webp"},
];
const contentSections = [
  {
    id: "docs", label: "01 / 文档", icon: BookOpen,
    title: ["从一个想法，", "到第一个插件。"],
    description: "怎么描述需求，如何确认结构，生成后怎样安装。把每一步看清楚，再开始构建。",
    action: "阅读使用文档", href: "https://minecraft-dev.pages.dev/",
  },
  {
    id: "community", label: "02 / QQ 群", icon: MessagesSquare,
    title: ["一起，把想法", "做出来。"],
    description: "分享插件想法，交流使用经验。遇到问题，也可以来群里聊聊。",
    action: "进入 QQ 群", href: "https://qm.qq.com/q/GQbHFjEp4k",
  },
];

let frame = 0;
let sceneTop = 0;
let travelLimit = 0;
let motionPreference: MediaQueryList | undefined;
let contentMeasurements: {stage: HTMLElement; top: number; limit: number}[] = [];

function updateScene() {
  frame = 0;
  if (!stage.value) return;
  const travel = motionPreference?.matches ? 0 : Math.min(travelLimit, Math.max(0, window.scrollY - sceneTop));
  stage.value.style.setProperty("--home-travel", `${travel}px`);
  stage.value.style.setProperty("--home-copy-opacity", `${Math.max(0, 1 - travel / (window.innerHeight * 1.05))}`);
  for (const content of contentMeasurements) {
    const offset = motionPreference?.matches ? 0 : Math.min(content.limit, Math.max(0, window.scrollY - content.top));
    content.stage.style.setProperty("--block-travel", `${offset}px`);
  }
}

function queueUpdate() {
  if (!frame) frame = window.requestAnimationFrame(updateScene);
}

function measureScene() {
  if (!scene.value || !stage.value) return;
  sceneTop = scene.value.getBoundingClientRect().top + window.scrollY;
  travelLimit = Math.max(0, scene.value.offsetHeight - stage.value.offsetHeight);
  contentMeasurements = contentScenes.value.flatMap((element) => {
    const contentStage = element.querySelector<HTMLElement>(".home-block-stage");
    return contentStage ? [{
      stage: contentStage,
      top: element.getBoundingClientRect().top + window.scrollY,
      limit: Math.max(0, element.offsetHeight - contentStage.offsetHeight),
    }] : [];
  });
  queueUpdate();
}

onMounted(() => {
  motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  motionPreference.addEventListener("change", measureScene);
  window.addEventListener("scroll", queueUpdate, {passive: true});
  window.addEventListener("resize", measureScene);
  measureScene();
});

onBeforeUnmount(() => {
  if (frame) window.cancelAnimationFrame(frame);
  motionPreference?.removeEventListener("change", measureScene);
  window.removeEventListener("scroll", queueUpdate);
  window.removeEventListener("resize", measureScene);
});
</script>

<style scoped>
.home-page { background: var(--surface-0); }

.home-parallax {
  position: relative;
  height: 220vh;
  background: var(--surface-0);
}

.home-parallax::after {
  content: "";
  position: absolute;
  z-index: 5;
  right: 0;
  bottom: 0;
  left: 0;
  height: 26vh;
  background: linear-gradient(transparent, var(--surface-0));
  pointer-events: none;
}

.home-stage {
  --home-travel: 0px;
  --home-copy-opacity: 1;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow: hidden;
  isolation: isolate;
}

.home-landscape { position: absolute; inset: 0; pointer-events: none; }
.home-layer { position: absolute; inset: -16%; will-change: transform; }
.home-layer img { display: block; width: 100%; height: 100%; object-fit: cover; user-select: none; }

.home-layer-far {
  z-index: 0;
  transform: translate3d(0, calc(var(--home-travel) * -0.018), 0);
}

.home-layer-middle {
  z-index: 1;
  transform: translate3d(0, calc(var(--home-travel) * -0.055), 0);
}

.home-layer-near {
  z-index: 2;
  transform: translate3d(0, calc(var(--home-travel) * -0.12), 0);
}

.home-atmosphere {
  position: absolute;
  z-index: 3;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(180deg, #0008 0%, #0004 38%, transparent 62%, #0003 100%);
}

.home-heading {
  position: absolute;
  z-index: 4;
  top: max(144px, 18vh);
  left: 43%;
  color: var(--wheat);
  opacity: var(--home-copy-opacity);
  transform: translate3d(0, calc(var(--home-travel) * -0.08), 0);
  text-shadow: 0 3px 30px #000c;
  pointer-events: none;
}
.home-eyebrow { margin-bottom: 16px; color: var(--oak); font-size: 14px; letter-spacing: 0.12em; }
.home-heading h1 { font-size: clamp(54px, 4.8vw, 82px); font-weight: 400; line-height: 1.16; }

.home-scroll-hint {
  position: absolute;
  z-index: 4;
  bottom: 30px;
  left: 48%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--surface-0);
  color: var(--wheat);
  font-size: 13px;
  opacity: var(--home-copy-opacity);
  pointer-events: none;
}

.home-block-scene { position: relative; height: 165vh; background: #000; }
.home-block-stage { --block-travel: 0px; position: sticky; top: 0; height: 100vh; overflow: hidden; isolation: isolate; }
.home-block-shapes, .home-block-plane { position: absolute; inset: 0; pointer-events: none; }
.home-block-plane { will-change: transform; }
.home-block-plane span { position: absolute; bottom: -60vh; border: 2px solid; }
.plane-far { z-index: 0; transform: translate3d(0, calc(var(--block-travel) * -0.06), 0); }
.plane-far span { background: #847342; border-color: #b08432; }
.plane-far .shape-one { left: 22%; width: 33%; top: 26%; }
.plane-far .shape-two { left: 70%; width: 33%; top: 28%; }
.plane-middle { z-index: 1; transform: translate3d(0, calc(var(--block-travel) * -0.18), 0); }
.plane-middle span { background: #cfb86f; border-color: #d7952c; }
.plane-middle .shape-one { left: -4%; width: 35%; top: 44%; }
.plane-middle .shape-two { left: 52%; width: 44%; top: 42%; }
.plane-near { z-index: 2; transform: translate3d(0, calc(var(--block-travel) * -0.32), 0); }
.plane-near span { background: #ffeda1; border-color: #e79913; }
.plane-near .shape-one { left: -8%; width: 24%; top: 70%; }
.plane-near .shape-two { left: 76%; width: 32%; top: 60%; }

.home-block-panel {
  position: absolute;
  z-index: 3;
  top: max(132px, 18vh);
  left: 8vw;
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: clamp(340px, 44vw, 660px);
  max-width: calc(100% - 16vw);
  min-height: calc(100vh - max(132px, 18vh) - 32px);
  padding: clamp(28px, 3.5vw, 56px);
  border: 2px solid #e79913;
  background: #ffeda1;
  color: #19160c;
  transform: translate3d(0, calc(var(--block-travel) * -0.04), 0);
}
.home-block-label { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; color: #75602a; font-size: 14px; }
.home-block-label svg { flex-shrink: 0; }
.home-block-panel h2 { font-size: clamp(36px, 3.6vw, 62px); font-weight: 400; line-height: 1.25; }
.home-block-description { margin-top: 24px; color: #63532e; font-size: 16px; line-height: 1.8; }
.home-block-action.lattice-button { align-self: flex-start; margin-top: 32px; border-color: #19160c; background: #19160c; color: #ffeda1; }
.home-block-action.lattice-button:hover { border-color: #3e3217; background: #3e3217; color: #fff3bf; }
.home-block-action.lattice-button:focus-visible { outline-color: #19160c; }
.scene-community .home-block-shapes { transform: scaleX(-1); }
.scene-community .home-block-panel { right: 8vw; left: auto; }

@media (prefers-reduced-motion: reduce) {
  .home-parallax { height: 100vh; }
  .home-layer { will-change: auto; }
  .home-layer, .home-heading { transform: none; }
  .home-scroll-hint { display: none; }
  .home-block-scene { height: 100vh; }
  .home-block-plane { will-change: auto; }
  .home-block-plane, .home-block-panel { transform: none; }
}
</style>

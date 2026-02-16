<template>
  <div class="floor-down">
    <section v-for="(item, i) in sections" :key="i"
             class="floor-section" :class="i % 2 === 0 ? 'img-right' : 'img-left'">
      <div class="floor-text">
        <h2 class="floor-title">{{ item.title }}</h2>
        <p class="floor-desc">{{ item.desc }}</p>
        <button v-if="item.action" class="floor-btn" @click="goChat">{{ item.action }}</button>
      </div>
      <div class="floor-img-wrap">
        <img :src="item.img" class="floor-img" alt="">
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import {useRouter} from "vue-router";

const router = useRouter();
const goChat = () => router.push("/chat");

const sections = [
  {
    title: "开始使用",
    desc: "通过左键我们就可以开始",
    img: "/pageA.png",
    action: "立即体验",
  },
  {
    title: "AI 驱动的开发指导",
    desc: "描述你的需求，AI 会将其拆解为可执行的开发步骤，包含事件监听、方法调用和参数说明",
    img: "/pageB.png",
    action: null,
  },
  {
    title: "全版本覆盖",
    desc: "支持 Paper / Bukkit / Spigot / Forge / Fabric，从 1.8 到 1.21 全版本适配",
    img: "/pageA.png",
    action: null,
  },
  {
    title: "步骤化输出",
    desc: "返回结构化的开发步骤，每一步标注需要的事件、方法和参数，直接对照实现",
    img: "/pageB.png",
    action: "开始对话",
  },
];
</script>

<style scoped>
.floor-down {
  position: relative;
  margin-top: 100vh;
  z-index: 1;
}

.floor-section {
  display: flex;
  align-items: center;
  min-height: 80vh;
  padding: 60px 8vw;
  gap: 40px;
}

.floor-section.img-right { flex-direction: row; }
.floor-section.img-left { flex-direction: row-reverse; }

.floor-text {
  flex: 0 0 30%;
  color: white;
}

.floor-title {
  font-size: 36px;
  margin-bottom: 16px;
  font-family: system-ui, sans-serif;
}

.floor-desc {
  font-size: 16px;
  opacity: 0.7;
  line-height: 1.6;
}

.floor-btn {
  margin-top: 24px;
  padding: 10px 28px;
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 12px;
  background: rgba(255,255,255,0.05);
  color: wheat;
  font-size: 15px;
  cursor: pointer;
  backdrop-filter: blur(6px);
  transition: background 0.2s;
}
.floor-btn:hover {
  background: rgba(255,255,255,0.12);
}

.floor-img-wrap {
  flex: 0 0 70%;
  position: relative;
  border-radius: 16px;
  overflow: hidden;
}

.floor-img {
  width: 100%;
  display: block;
  border-radius: 16px;
  opacity: 0.95;
}

.floor-img-wrap::before,
.floor-img-wrap::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 80px;
  z-index: 1;
  pointer-events: none;
}
.floor-img-wrap::before {
  top: 0;
  background: linear-gradient(to bottom, #000, transparent);
}
.floor-img-wrap::after {
  bottom: 0;
  background: linear-gradient(to top, #000, transparent);
}
</style>

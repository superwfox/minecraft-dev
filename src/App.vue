<template>
  <CubeBackground/>
  <GlassCard>
    <div class="header">
      踏海
    </div>

    <div class="center">
      NOW_ON_WORKING
    </div>

    <div class="right">
      <a class="link" href="https://minecraft-dev.pages.dev/" rel="noreferrer">文档</a>
      <a class="link" href="https://github.com/superwfox/minecraft-dev" rel="noreferrer">GitHub</a>
    </div>
  </GlassCard>
</template>

<script setup lang="ts">
import CubeBackground from "./index/cubeBackground.vue";
import GlassCard from "./index/glassCard.vue"; // 注意大小写/路径
</script>

<style>
.ui-layer {
  position: fixed;
  inset: 0;
  z-index: 1;
  display: grid;
  place-items: center;
  pointer-events: none; /* 让你可以控制哪些区域可交互 */
}

/* 让卡片本身可交互 */
.ui-layer > * {
  pointer-events: auto;
}

.btn {
  margin-top: 12px;
}
</style>

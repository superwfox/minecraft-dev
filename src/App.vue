<template>
  <CubeBackground/>
  <GlassCard>
    <div class="header" @click = goHome>
      <img class="header-icon" src="/icon.png" alt="icon" @click = goHome>
      TAHAI
    </div>

    <div class="center">
      <span>{{ centerText }}</span>
    </div>

    <div class="right">
      <a class="link" href="https://minecraft-dev.pages.dev/" rel="noreferrer">文档</a>
      <a class="link" href="https://github.com/superwfox/minecraft-dev" rel="noreferrer">GitHub</a>
    </div>
  </GlassCard>
  <router-view/>
</template>

<script setup lang="ts">
import {provide, ref} from "vue";
import CubeBackground from "./index/cubeBackground.vue";
import GlassCard from "./index/glassCard.vue";
import {useRouter} from "vue-router";

const router = useRouter();
const goHome = () => router.push("/");

const centerText = ref("建设中");
provide("centerText", centerText);
</script>

<style>
@font-face {
  font-family: "ZhuoKai";
  src: url("/jiangxizhuokai_subset.woff2") format("woff2");
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background: #000;
  font-family: "ZhuoKai", system-ui, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
}
</style>

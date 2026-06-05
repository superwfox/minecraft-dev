<template>
  <GlassCard>
    <div class="header" @click = goHome>
      <img class="header-icon" src="/icon.png" alt="icon" @click = goHome>
      <span class="header-title">TAHAI</span>
    </div>

    <div class="center">
      <span>{{ centerText }}</span>
    </div>

    <div class="right">
      <router-link class="link" to="/ide">IDE</router-link>
      <a class="link" href="https://minecraft-dev.pages.dev/" rel="noreferrer">文档</a>
      <a class="link" href="https://github.com/superwfox/minecraft-dev" rel="noreferrer">GitHub</a>
    </div>
  </GlassCard>
  <router-view/>
</template>

<script setup lang="ts">
import {provide, ref, onMounted} from "vue";
import GlassCard from "./components/glassCard.vue";
import {useRouter} from "vue-router";
import {restoreSession, startSessionPersistence} from "./logic/sessionPersist";

const router = useRouter();
const goHome = () => router.push("/");

const centerText = ref("");
provide("centerText", centerText);

restoreSession();
onMounted(() => startSessionPersistence());
</script>

<style>
@font-face {
  font-family: "ZhuoKai";
  src: url("/jiangxizhuokai_subset.woff2") format("woff2");
  font-weight: normal;
  font-style: normal;
  font-display: swap;
  unicode-range: U+0041, U+0048, U+0049, U+0054, U+4E00-9FFF, U+3000-303F, U+FF00-FFEF;
}

@font-face {
  font-family: "Monaco";
  src: url("font/Monaco.ttf") format("truetype");
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
  font-family: "Monaco", "ZhuoKai", system-ui, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
}

.header-title {
  font-family: "ZhuoKai", sans-serif;
}

* {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}
*::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
*::-webkit-scrollbar-track {
  background: transparent;
}
*::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  transition: background 0.2s;
}
*::-webkit-scrollbar-thumb:hover {
  background: wheat;
}
*::-webkit-scrollbar-corner {
  background: transparent;
}
</style>

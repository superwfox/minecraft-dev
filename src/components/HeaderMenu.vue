<template>
  <div ref="root" class="header-menu" @focusout="onFocusOut" @keydown.esc.stop.prevent="close(true)">
    <button
      ref="trigger"
      v-lattice:icon
      type="button"
      class="header-menu-trigger"
      aria-label="更多入口"
      aria-controls="header-links-menu"
      :aria-expanded="open"
      @click="open = !open"
      @keydown.down.prevent="openAndFocus"
    ><span class="header-menu-dots" aria-hidden="true"><span/><span/><span/></span></button>
    <nav v-if="open" id="header-links-menu" v-lattice:two class="header-menu-panel" aria-label="快捷入口">
      <button v-if="authState.loaded && !authState.user" v-lattice type="button" class="header-menu-item" @click="signIn">登录</button>
      <a v-lattice class="header-menu-item" href="https://minecraft-dev.pages.dev/" rel="noreferrer" @click="close()">文档</a>
      <a v-lattice class="header-menu-item" href="https://qm.qq.com/q/GQbHFjEp4k" target="_blank" rel="noopener noreferrer" @click="close()">QQ 群</a>
    </nav>
  </div>
</template>

<script setup lang="ts">
import {nextTick, onBeforeUnmount, onMounted, ref, watch} from "vue";
import {useRoute} from "vue-router";
import {authState, login} from "../logic/auth";

const route = useRoute();
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);

function close(restoreFocus = false) {
  open.value = false;
  if (restoreFocus) trigger.value?.focus();
}

function signIn() {
  close();
  login();
}

async function openAndFocus() {
  open.value = true;
  await nextTick();
  root.value?.querySelector<HTMLElement>("nav button, nav a")?.focus();
}

function onPointerDown(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target)) close();
}

function onFocusOut(event: FocusEvent) {
  if (!(event.relatedTarget instanceof Node) || !root.value?.contains(event.relatedTarget)) close();
}

watch(() => route.fullPath, () => close());
onMounted(() => document.addEventListener("pointerdown", onPointerDown));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onPointerDown));
</script>

<style scoped>
@layer lattice {
  .header-menu { position: relative; display: flex; align-items: center; }
  .header-menu-dots { display: flex; align-items: center; gap: 2px; }
  .header-menu-dots > span { width: 5px; height: 5px; background: currentColor; }
  .header-menu-panel.lattice-frame {
    position: absolute;
    top: calc(100% + 30px);
    right: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 200px;
    max-width: calc(100vw - 48px);
    padding: 22px;
  }
  .header-menu-item.lattice-button { width: 100%; justify-content: flex-start; }
}
</style>

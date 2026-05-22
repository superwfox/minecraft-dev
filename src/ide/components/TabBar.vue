<template>
  <div class="tab-bar" v-if="tabs.length">
    <div class="tab-scroll" ref="scrollEl">
      <div v-for="path in tabs" :key="path"
           class="tab" :class="{active: path === currentPath}"
           @click="$emit('select', path)"
           @auxclick.middle.prevent="$emit('close', path)">
        <FileIcon kind="file" :path="path"/>
        <span class="tab-name">{{ basename(path) }}</span>
        <span v-if="dirtyMap[path]" class="tab-dirty">●</span>
        <span class="tab-close" @click.stop="$emit('close', path)" title="关闭">×</span>
      </div>
    </div>
    <div class="tab-overflow"></div>
  </div>
</template>

<script setup lang="ts">
import {ref, watch, nextTick} from "vue";

const props = defineProps<{
    tabs: string[];
    currentPath: string;
    dirtyMap: Record<string, boolean>;
}>();

defineEmits<{
    (e: "select", path: string): void;
    (e: "close", path: string): void;
}>();

const scrollEl = ref<HTMLElement | null>(null);

function basename(path: string) {
    return path.split("/").pop() || path;
}

watch(() => props.currentPath, async () => {
    await nextTick();
    const el = scrollEl.value?.querySelector(".tab.active") as HTMLElement | null;
    el?.scrollIntoView({behavior: "smooth", block: "nearest", inline: "nearest"});
});
</script>

<style scoped>
.tab-bar {
  display: flex;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  background: rgba(8, 8, 10, 0.4);
  height: 36px;
  flex-shrink: 0;
  overflow: hidden;
}
.tab-scroll {
  display: flex;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.tab-scroll::-webkit-scrollbar { display: none; }
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px 0 12px;
  height: 36px;
  border-right: 1px solid rgba(255,255,255,0.04);
  cursor: pointer;
  font-size: 12px;
  color: rgba(255,255,255,0.55);
  font-family: "Monaco", monospace;
  white-space: nowrap;
  position: relative;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s;
}
.tab:hover {
  color: rgba(255,255,255,0.85);
  background: rgba(255,255,255,0.03);
}
.tab.active {
  color: wheat;
  background: rgba(13, 13, 15, 0.9);
}
.tab.active::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: wheat;
}
.tab-name {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab-dirty {
  color: wheat;
  font-size: 9px;
}
.tab-close {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: rgba(255,255,255,0.3);
  border-radius: 4px;
  margin-left: 2px;
  transition: all 0.15s;
}
.tab-close:hover {
  background: rgba(255,255,255,0.1);
  color: wheat;
}
.tab-overflow {
  flex: 1;
  background: rgba(8, 8, 10, 0.4);
}
</style>

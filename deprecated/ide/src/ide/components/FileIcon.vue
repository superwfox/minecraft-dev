<template>
  <span class="file-icon" :style="{color: tint}">
    <svg v-if="kind === 'folder-open'" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
      <path d="M1.5 3.5a1 1 0 0 1 1-1h3.586a1 1 0 0 1 .707.293L8 4h5.5a1 1 0 0 1 1 1v1.5h-12V3.5Zm.182 4 1.2 5.4a1 1 0 0 0 .976.78h9.284a1 1 0 0 0 .976-.78l1.2-5.4a.6.6 0 0 0-.585-.73H2.267a.6.6 0 0 0-.585.73Z"/>
    </svg>
    <svg v-else-if="kind === 'folder-closed'" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
      <path d="M1.5 4.5a1.5 1.5 0 0 1 1.5-1.5h3.379a1.5 1.5 0 0 1 1.06.44L8.5 4.5h5a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-8Z"/>
    </svg>
    <svg v-else viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
      <path d="M3 1.5A1.5 1.5 0 0 1 4.5 0H9l4 4v10.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14.5v-13ZM9 0v3.5A.5.5 0 0 0 9.5 4H13"/>
    </svg>
  </span>
</template>

<script setup lang="ts">
import {computed} from "vue";

const props = defineProps<{
    kind: "file" | "folder-open" | "folder-closed";
    path?: string;
}>();

const tint = computed(() => {
    if (props.kind !== "file") return "#9aa0a6";
    const ext = (props.path || "").split(".").pop()?.toLowerCase() || "";
    const palette: Record<string, string> = {
        java: "#e7a062",
        kt: "#c792ea",
        xml: "#82aaff",
        yml: "#89ddff",
        yaml: "#89ddff",
        properties: "#a3be8c",
        json: "#ffcb6b",
        md: "#b3c4d4",
        gradle: "#69d6a0",
        ts: "#82aaff",
        js: "#ffcb6b",
        html: "#ff8b6c",
        css: "#c792ea",
    };
    return palette[ext] || "#8b9097";
});
</script>

<style scoped>
.file-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  transition: color 0.15s;
}
</style>

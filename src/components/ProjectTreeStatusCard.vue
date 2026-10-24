<template>
  <div v-lattice:two class="tree-status-card" role="status" :aria-busy="!!busy">
    <strong><i aria-hidden="true"/>{{ label }}</strong>
    <span>{{ detail }}</span>
  </div>
</template>

<script setup lang="ts">
// Loading and future tool-call effects belong here, alongside the exterior corners.
defineProps<{ label: string; detail: string; busy?: boolean }>();
</script>

<style scoped>
@layer legacy {
.tree-status-card{display:flex;flex-direction:column;justify-content:center;gap:9px;padding:22px 25px;min-height:92px;min-width:220px;--lattice-corner-inset:-1px}
.tree-status-card strong{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:400}
.tree-status-card i{width:5px;height:5px;border-radius:50%;background:var(--oak)}
.tree-status-card>span{font-size:10px;color:var(--text-muted)}
}
</style>

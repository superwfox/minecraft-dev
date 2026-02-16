<template>
  <div class="step-render">
    <div class="step-tags" v-if="block.coreType || block.version">
      <span class="tag tag-core" v-if="block.coreType">{{ block.coreType }}</span>
      <span class="tag tag-ver" v-if="block.version">{{ block.version }}</span>
    </div>

    <div v-for="s in block.steps" :key="s.step" class="step-item">
      <div class="step-head">
        <span class="step-num">Step {{ s.step }}</span>
        <span v-if="s.event" class="badge badge-event">{{ s.event }}</span>
        <span v-if="s.function" class="badge badge-func">{{ s.function }}</span>
      </div>
      <div class="step-content" v-if="s.content">{{ s.content }}</div>
      <div class="step-params" v-if="s.params && s.params.length">
        <span v-for="(p, i) in s.params" :key="i" class="badge badge-param">{{ p }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type {ChatBlock} from "./chatState";
defineProps<{ block: ChatBlock }>();
</script>

<style scoped>
.step-render {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.step-tags {
  display: flex;
  gap: 8px;
}

.tag {
  padding: 3px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
}
.tag-core, .tag-ver {
  background: wheat;
  color: #111;
}

.step-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.step-num {
  color: rgba(255,255,255,0.5);
  font-size: 13px;
}

.badge {
  padding: 2px 10px;
  border-radius: 6px;
  font-size: 12px;
}
.badge-event {
  background: rgba(85,200,255,0.2);
  color: #55c8ff;
}
.badge-func {
  background: rgba(245,166,35,0.2);
  color: #f5a623;
}
.badge-param {
  background: rgba(255,255,255,0.08);
  color: #999;
}

.step-content {
  color: white;
  font-size: 15px;
  line-height: 1.5;
}

.step-params {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>

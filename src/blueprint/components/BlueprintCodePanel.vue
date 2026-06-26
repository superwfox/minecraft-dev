<template>
  <transition name="cp-slide">
    <div v-if="open" class="cp-panel">
      <div class="cp-head">
        <div class="cp-tabs">
          <button class="cp-tab" :class="{on: mode === 'graph'}" @click="mode = 'graph'">当前图</button>
          <button class="cp-tab" :class="{on: mode === 'plugin'}" @click="mode = 'plugin'">整插件</button>
          <button class="cp-tab imp" :class="{on: mode === 'import'}" @click="mode = 'import'">导入代码 →图</button>
        </div>
        <span v-if="mode !== 'import'" class="cp-hint">图是真相源 · 代码为产物</span>
        <span v-else class="cp-hint">粘贴 Java · 确定性解析回图</span>
        <button v-if="mode !== 'import'" class="cp-copy" @click="copy">{{ copied ? "已复制" : "复制" }}</button>
        <button class="cp-close" @click="$emit('close')">✕</button>
      </div>

      <pre v-if="mode !== 'import'" class="cp-code"><code>{{ code }}</code></pre>

      <div v-else class="cp-import">
        <textarea v-model="importText" class="cp-ta" spellcheck="false"
                  placeholder="把 Java 源码粘到这里(可直接用上面「整插件」生成的代码做往返测试)…"></textarea>
        <div class="cp-imrow">
          <button class="cp-parse" :disabled="!importText.trim()" @click="doImport">解析为图</button>
          <span class="cp-status" :class="{err: status.err}">{{ status.msg }}</span>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useBlueprint } from "../useBlueprint";
import { generatePlugin, generateGraphCode } from "../codegen";
import { parseJavaToDoc } from "../parse";

defineProps<{ open: boolean }>();
defineEmits<{ (e: "close"): void }>();

const bp = useBlueprint();
const mode = ref<"graph" | "plugin" | "import">("graph");
const copied = ref(false);
const importText = ref("");
const status = ref<{ msg: string; err: boolean }>({ msg: "", err: false });

function doImport() {
    const res = parseJavaToDoc(importText.value);
    if (res.error) { status.value = { msg: res.error, err: true }; return; }
    const r = bp.importParsed(res);
    if (!r.added) { status.value = { msg: "未解析出任何方法/图", err: true }; return; }
    status.value = { msg: `导入 ${r.added} 张图` + (r.warnings ? ` · ${r.warnings} 处降级为逃逸节点` : " · 全部映射成功"), err: false };
}

const code = computed(() => {
    const doc = bp.state.doc;
    if (!doc) return "// 暂无图";
    try {
        if (mode.value === "plugin") return generatePlugin(doc);
        const g = bp.currentGraph.value;
        return g ? generateGraphCode(g, doc) : "// 未选中图";
    } catch (e: any) {
        return "// 生成失败:" + (e?.message || e);
    }
});

async function copy() {
    try {
        await navigator.clipboard.writeText(code.value);
        copied.value = true;
        setTimeout(() => (copied.value = false), 1400);
    } catch { /* 剪贴板不可用时静默 */ }
}
</script>

<style scoped>
.cp-panel {
  position: absolute; top: 0; right: 0; bottom: 0; width: 460px; max-width: 60%; z-index: 30;
  display: flex; flex-direction: column;
  background: rgba(10, 10, 12, 0.94); border-left: 1px solid rgba(255,255,255,0.1);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  box-shadow: -8px 0 28px rgba(0,0,0,0.45);
}
.cp-head {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px; flex-shrink: 0;
  border-bottom: 1px solid rgba(255,255,255,0.07);
}
.cp-tabs { display: flex; gap: 4px; }
.cp-tab {
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.6); font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-family: inherit;
}
.cp-tab.on { background: rgba(137,221,255,0.16); border-color: rgba(137,221,255,0.4); color: #cdeeff; }
.cp-hint { font-size: 10px; color: rgba(255,255,255,0.32); margin-left: 2px; }
.cp-copy {
  margin-left: auto; background: rgba(163,190,140,0.18); border: 1px solid rgba(0,0,0,0.4);
  color: #e6f0d8; font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-family: inherit;
}
.cp-copy:hover { filter: brightness(1.15); }
.cp-close {
  background: transparent; border: none; color: rgba(255,255,255,0.5); font-size: 14px; cursor: pointer; padding: 2px 4px;
}
.cp-close:hover { color: #ff7a7a; }
.cp-code {
  flex: 1; overflow: auto; margin: 0; padding: 14px 16px;
  font-family: "Monaco", "Menlo", monospace; font-size: 12px; line-height: 1.55;
  color: #cfe3ef; white-space: pre; tab-size: 4;
}
.cp-code code { color: inherit; background: none; }

.cp-tab.imp.on { background: rgba(191,97,106,0.2); border-color: rgba(191,97,106,0.5); color: #f0c4c8; }
.cp-import { flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 12px; gap: 10px; }
.cp-ta {
  flex: 1; min-height: 0; resize: none; box-sizing: border-box;
  background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;
  color: #cfe3ef; font-family: "Monaco", "Menlo", monospace; font-size: 12px; line-height: 1.5;
  padding: 10px 12px; outline: none; tab-size: 4;
}
.cp-ta:focus { border-color: rgba(137,221,255,0.4); }
.cp-imrow { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.cp-parse {
  background: rgba(137,221,255,0.18); border: 1px solid rgba(0,0,0,0.4);
  color: #cdeeff; font-size: 13px; padding: 7px 18px; border-radius: 7px; cursor: pointer; font-family: inherit;
  box-shadow: inset 1px 1px 0 rgba(255,255,255,0.1), inset -1px -1px 0 rgba(0,0,0,0.4);
}
.cp-parse:hover:not(:disabled) { filter: brightness(1.18); }
.cp-parse:disabled { opacity: 0.4; cursor: default; }
.cp-status { font-size: 11px; color: rgba(163,190,140,0.95); }
.cp-status.err { color: #ff9b9b; }

.cp-slide-enter-active, .cp-slide-leave-active { transition: transform 0.28s cubic-bezier(0.32,0.72,0.24,1); }
.cp-slide-enter-from, .cp-slide-leave-to { transform: translateX(100%); }
</style>

<template>
  <div class="bp-view">
    <div class="bp-topbar">
      <button class="bp-back" @click="$emit('back')">
        <span class="ba-arrow">‹</span> 代码视图
      </button>
      <div class="bp-graphname">
        <span class="gn-dot"></span>
        <span class="gn-text">{{ bp.currentGraph.value?.name || "蓝图" }}</span>
        <span class="gn-tag">可视化蓝图 · 预览</span>
      </div>
      <button class="bp-codebtn" :class="{on: showCode}" @click="showCode = !showCode">
        <span class="cb-ico">&lt;/&gt;</span> 代码
      </button>
      <div class="bp-meta">{{ nodeCount }} 节点 · {{ edgeCount }} 连线</div>
    </div>
    <div class="bp-main">
      <BlueprintPalette @pick="onPick" @pick-var="onPickVar"/>
      <BlueprintCanvas ref="canvasRef"/>
      <BlueprintGraphTray/>
      <BlueprintCodePanel :open="showCode" @close="showCode = false"/>
      <transition name="bp-toast">
        <div v-if="toast" class="bp-toast">{{ toast }}</div>
      </transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useBlueprint } from "../useBlueprint";
import { parseFiles } from "../parse";
import { useIDEStore } from "../../ide/composables/useIDEStore";
import BlueprintPalette from "./BlueprintPalette.vue";
import BlueprintCanvas from "./BlueprintCanvas.vue";
import BlueprintGraphTray from "./BlueprintGraphTray.vue";
import BlueprintCodePanel from "./BlueprintCodePanel.vue";

const props = defineProps<{ taskId: string }>();
defineEmits<{ (e: "back"): void }>();

const bp = useBlueprint();
const ide = useIDEStore();
const canvasRef = ref<InstanceType<typeof BlueprintCanvas> | null>(null);
const showCode = ref(false);
const toast = ref("");

const nodeCount = computed(() => bp.currentGraph.value?.nodes.length || 0);
const edgeCount = computed(() => bp.currentGraph.value?.edges.length || 0);

function flashToast(msg: string) {
    toast.value = msg;
    setTimeout(() => { if (toast.value === msg) toast.value = ""; }, 4200);
}

// 进入蓝图:加载已存蓝图;若尚无蓝图(fresh),把已生成的 .java 自动解析成多张图铺出来
// (bluemap §1.1 画布是 AI 产物的视图;§4.1 码→图只发生一次,之后图即真相)
async function enter(taskId: string) {
    await bp.loadForTask(taskId);
    if (!bp.state.fresh) return;
    const files = ide.state.files.filter(f => /\.java$/i.test(f.path));
    if (!files.length) return;
    const r = bp.replaceWithParsed(parseFiles(files));
    if (r.added) flashToast(`已从已生成代码导入 ${r.added} 张图` + (r.warnings ? ` · ${r.warnings} 处降级为逃逸节点` : ""));
}
onMounted(() => { if (props.taskId) enter(props.taskId); });
watch(() => props.taskId, (id) => { if (id) enter(id); });

function onPick(defType: string) { canvasRef.value?.addDefAtCenter(defType); }
function onPickVar(name: string) { canvasRef.value?.varAtCenter(name); }
</script>

<style scoped>
.bp-view { display: flex; flex-direction: column; flex: 1; min-height: 0; background: rgba(13, 13, 15, 0.6); }
.bp-topbar {
  display: flex; align-items: center; gap: 14px; height: 40px; flex-shrink: 0;
  padding: 0 14px; background: rgba(8, 8, 10, 0.6);
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.bp-back {
  display: inline-flex; align-items: center; gap: 4px;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.82); font-size: 12px; padding: 5px 12px; border-radius: 7px; cursor: pointer; font-family: inherit;
}
.bp-back:hover { background: rgba(255,255,255,0.1); }
.ba-arrow { font-size: 16px; line-height: 1; }
.bp-graphname { display: flex; align-items: center; gap: 8px; }
.gn-dot { width: 9px; height: 9px; border-radius: 2px; background: #89ddff; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.4); }
.gn-text { font-size: 13px; color: rgba(255,255,255,0.9); font-weight: 500; }
.gn-tag { font-size: 10px; color: rgba(255,255,255,0.35); padding: 2px 8px; border-radius: 10px; background: rgba(137,221,255,0.1); border: 1px solid rgba(137,221,255,0.18); }
.bp-codebtn {
  margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.82); font-size: 12px; padding: 5px 12px; border-radius: 7px; cursor: pointer; font-family: inherit;
}
.bp-codebtn:hover { background: rgba(255,255,255,0.1); }
.bp-codebtn.on { background: rgba(137,221,255,0.16); border-color: rgba(137,221,255,0.4); color: #cdeeff; }
.cb-ico { font-family: "Monaco", monospace; font-size: 11px; opacity: 0.8; }
.bp-meta { margin-left: 14px; font-size: 11px; font-family: "Monaco", monospace; color: rgba(255,255,255,0.4); }
.bp-main { flex: 1; display: flex; min-height: 0; position: relative; }

.bp-toast {
  position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 40;
  background: rgba(12,14,16,0.92); border: 1px solid rgba(137,221,255,0.3);
  color: #cdeeff; font-size: 12px; padding: 9px 18px; border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5); white-space: nowrap;
}
.bp-toast-enter-active, .bp-toast-leave-active { transition: opacity 0.3s, transform 0.3s; }
.bp-toast-enter-from, .bp-toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(8px); }
</style>

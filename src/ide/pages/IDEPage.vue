<template>
  <div class="ide-page" ref="ideEl">
    <!-- 顶部工具栏 -->
    <div class="ide-toolbar">
      <div class="toolbar-left">
        <span class="toolbar-task" v-if="state.taskId">
          <span class="task-label">task</span>
          <span class="task-id">{{ state.taskId.slice(0, 12) }}</span>
        </span>
        <span v-else class="toolbar-task placeholder">未加载任务</span>
        <span v-if="dirtyCount" class="toolbar-dirty">
          <span class="dirty-mark">●</span>
          {{ dirtyCount }} 个未保存
        </span>
        <span v-if="pomLabel" class="toolbar-pom" :class="`pom-${pomStatus?.phase}`">
          <span class="pom-spinner" v-if="pomStatus?.phase === 'downloading' || pomStatus?.phase === 'parsing'"></span>
          {{ pomLabel }}
        </span>
      </div>
      <div class="toolbar-right" v-if="!blueprint">
        <button class="tb-btn" :disabled="!dirtyCount" @click="onSave" title="保存全部 (⌘S)">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M11 2H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V5l-3-3Zm0 2.5L13.5 7H10V4.5h1ZM4 4h5v3a1 1 0 0 0 1 1h3v4H4V4Zm2 6h6v1H6v-1Zm0-2h6v1H6V8Z"/>
          </svg>
          <span>保存</span>
        </button>
        <button class="tb-btn primary" :disabled="!state.files.length" @click="onCompile" title="保存并触发编译">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M3.5 2.5a1 1 0 0 1 1.5-.87l9 5.5a1 1 0 0 1 0 1.74l-9 5.5a1 1 0 0 1-1.5-.87v-11Z"/>
          </svg>
          <span>编译</span>
        </button>
      </div>
    </div>

    <!-- 主体：代码舞台 ⇄ 蓝图舞台（整体塌缩动画切换）-->
    <div class="ide-body">
      <Transition name="collapse">
        <div v-if="!blueprint" class="code-stage">
          <div class="ide-sidebar" :style="{width: state.sidebarWidth + 'px'}">
            <FileTree :files="state.files"
                      :current-path="state.currentPath"
                      :collapsed-folders="state.collapsedFolders"
                      :collapsed-categories="state.collapsedCategories"
                      :view-mode="state.viewMode"
                      @select="openFile"
                      @toggle-folder="toggleFolder"
                      @toggle-category="toggleCategory"
                      @change-view="setViewMode"
                      @enter-blueprint="enterBlueprint"/>
          </div>

          <div class="ide-resizer" @mousedown="startResize"></div>

          <div class="ide-editor-col">
            <TabBar :tabs="state.openTabs"
                    :current-path="state.currentPath"
                    :dirty-map="dirtyMap"
                    @select="openFile"
                    @close="closeTab"/>
            <EditorPanel v-if="currentFile"
                         :path="currentFile.path"
                         :role="currentFile.role"
                         :model-value="currentFile.content"
                         :bottom-gutter="editorBottomGutter"
                         @update:model-value="onContentChange"
                         @cursor="setCursor"/>
            <div v-else class="empty-editor">
              <div class="empty-art">⌘</div>
              <div class="empty-text">从左侧选择一个文件开始编辑</div>
              <div class="empty-hint">⌘P 快速打开 · ⌘S 保存</div>
            </div>
          </div>

          <!-- 底部 AI 聊天 dock -->
          <BottomChatDock :state="dockState"
                          :messages="chat.state.messages"
                          :streaming="chat.state.streaming"
                          :streaming-text="chat.state.streamingText"
                          :context-hint="dockContextHint"
                          @send="onDockSend"
                          @open-file="openFile"
                          @request-open="dockState = 'open'"
                          @close="dockState = 'dormant'"/>
        </div>
      </Transition>

      <Transition name="bpenter">
        <BlueprintView v-if="blueprint" class="bp-stage" :task-id="state.taskId" @back="exitBlueprint"/>
      </Transition>
    </div>

    <!-- 状态栏 -->
    <div class="ide-statusbar">
      <div class="sb-left">
        <span class="sb-item" v-if="currentFile">
          <span class="sb-icon">⏿</span> 行 {{ state.cursor.line }}, 列 {{ state.cursor.col }}
        </span>
        <span class="sb-item" v-if="currentFile">
          <span class="sb-dot" :style="{background: dirtyCount > 0 ? '#f5deb3' : '#5a9d6f'}"></span>
          {{ dirtyCount > 0 ? "有未保存修改" : "已保存" }}
        </span>
      </div>
      <div class="sb-right">
        <span class="sb-item">UTF-8</span>
        <span class="sb-item">LF</span>
        <span class="sb-item" v-if="currentFile">{{ langLabel }}</span>
        <span class="sb-item">{{ state.files.length }} files</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {onMounted, onBeforeUnmount, computed, ref} from "vue";
import {useRoute, useRouter} from "vue-router";
import FileTree from "../components/FileTree.vue";
import EditorPanel from "../components/EditorPanel.vue";
import TabBar from "../components/TabBar.vue";
import BottomChatDock from "../components/BottomChatDock.vue";
import BlueprintView from "../../blueprint/components/BlueprintView.vue";
import {useIDEStore, type IDESeedFile} from "../composables/useIDEStore";
import {useIDEChat} from "../composables/useIDEChat";
import {loadFromPom, type LoadStatus} from "../composables/useJarSymbols";
import {setDynamicDict} from "../composables/useBukkitDict";
import {genTask, resetGenTask} from "../../logic/generateState";
import {startBuildFromIDE} from "../../logic/generateHandler";

const route = useRoute();
const router = useRouter();
const {state, currentFile, dirtyCount, loadFromTask, saveAll, updateContent,
       openFile, closeTab, toggleFolder, toggleCategory, setCursor, setSidebarWidth, setViewMode,
       setIdeMode, upsertFile, saveMeta, loadMeta} = useIDEStore();

const blueprint = computed(() => state.ideMode === "blueprint");
function enterBlueprint() { setIdeMode("blueprint"); }
function exitBlueprint() { setIdeMode("code"); }

const dirtyMap = computed(() => {
    const m: Record<string, boolean> = {};
    for (const f of state.files) m[f.path] = f.dirty;
    return m;
});

const langLabel = computed(() => {
    const ext = (currentFile.value?.path || "").split(".").pop()?.toUpperCase() || "TXT";
    return ext;
});

// ---- 动态补全：pom.xml 检测 + JAR 拉取 ----
const pomStatus = ref<LoadStatus | null>(null);
const pomLabel = computed(() => {
    const s = pomStatus.value;
    if (!s) return "";
    const artifact = s.coords?.split(":")[1] || "";
    if (s.phase === "downloading") {
        const pct = s.total ? Math.floor((s.loaded || 0) / s.total * 100) : 0;
        return `${artifact} ${pct}%`;
    }
    if (s.phase === "parsing") {
        return `${artifact} 解析 ${s.classCount || 0}${s.total ? "/" + s.total : ""}`;
    }
    if (s.phase === "done") return `${artifact} ✓ ${s.classCount} 类`;
    if (s.phase === "error") return `${artifact} 失败`;
    return "";
});

async function refreshPomSymbols() {
    const pom = state.files.find(f => f.path === "pom.xml" || f.path.endsWith("/pom.xml"));
    if (!pom) return;
    try {
        const classes = await loadFromPom(pom.content, (s) => { pomStatus.value = s; });
        if (classes.length) setDynamicDict(classes);
        // 完成态常驻显示，给用户明确反馈"已加载 N 个类"
    } catch (e) {
        pomStatus.value = {phase: "error", error: String(e)};
    }
}

// ---- 底部 dock：状态 + 消息全部来自 useIDEChat 单例 ----
const chat = useIDEChat();
const dockState = chat.dockState;
const dockContextHint = computed(() => currentFile.value?.path.split("/").pop() || "");
const ideEl = ref<HTMLElement | null>(null);

// 整个 IDE 底部 100px 范围都是 hint 触发区（不只是文件栏）
const HINT_TRIGGER_PX = 110;
const HINT_RELEASE_PX = 170;

function onMouseMove(e: MouseEvent) {
    if (dockState.value === "open") return;
    if (!ideEl.value) return;
    const rect = ideEl.value.getBoundingClientRect();
    const distFromBottom = rect.bottom - e.clientY;
    const insideX = e.clientX >= rect.left && e.clientX <= rect.right;
    if (!insideX || distFromBottom < 0) {
        if (dockState.value === "hint") dockState.value = "dormant";
        return;
    }
    if (dockState.value === "dormant" && distFromBottom <= HINT_TRIGGER_PX) {
        dockState.value = "hint";
    } else if (dockState.value === "hint" && distFromBottom > HINT_RELEASE_PX) {
        dockState.value = "dormant";
    }
}

// 编辑器底部留白：永久 60px，hint 状态多留 30，open 时按 dock 高度
const editorBottomGutter = computed(() => {
    if (dockState.value === "open") {
        const h = Math.min(Math.round(window.innerHeight * 0.6), 640);
        return h + 80;
    }
    if (dockState.value === "hint") return 110;
    return 80;
});

async function onDockSend(text: string) {
    await chat.send(text);
}

onMounted(async () => {
    const taskId = (route.params.taskId as string) || genTask.taskId || "demo";
    const seed: IDESeedFile[] = (genTask.files || [])
        .filter(f => f.content)
        .map(f => ({
            path: f.path,
            content: f.content!,
            generatorType: f.generatorType ?? null,
            role: f.role || "",
        }));
    if (!seed.length) {
        seed.push(
            {path: "pom.xml", content: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<project>\n    <groupId>com.tahai</groupId>\n    <artifactId>demo</artifactId>\n    <version>1.0.0</version>\n</project>\n", generatorType: "FileRelatedGen", role: "Maven 构建"},
            {path: "src/main/java/com/tahai/Main.java", content: "package com.tahai;\n\nimport org.bukkit.plugin.java.JavaPlugin;\n\npublic class Main extends JavaPlugin {\n    @Override\n    public void onEnable() {\n        getLogger().info(\"Demo enabled\");\n    }\n}\n", generatorType: "MainGen", role: "插件主类"},
            {path: "src/main/java/com/tahai/JoinListener.java", content: "package com.tahai;\n\nimport org.bukkit.event.EventHandler;\nimport org.bukkit.event.Listener;\nimport org.bukkit.event.player.PlayerJoinEvent;\n\npublic class JoinListener implements Listener {\n    @EventHandler\n    public void onJoin(PlayerJoinEvent e) {\n    }\n}\n", generatorType: "ListenerGen", role: "玩家加入监听"},
            {path: "src/main/resources/plugin.yml", content: "name: Demo\nversion: 1.0\nmain: com.tahai.Main\napi-version: 1.21\n", generatorType: "FileRelatedGen", role: "插件描述"},
            {path: "src/main/resources/config.yml", content: "maintenance-mode: false\n", generatorType: "ConfigGen", role: "运行时配置"},
        );
    }
    await loadFromTask(taskId, seed);
    // genTask 有构建元数据时（从生成流程进来）持久化，供日后缓存重载/KV 过期后重建用
    if (genTask.javaVersion || genTask.projectName) {
        saveMeta(taskId, {
            javaVersion: genTask.javaVersion,
            projectName: genTask.projectName,
            packageName: genTask.packageName,
        });
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousemove", onMouseMove);
    refreshPomSymbols();
});

onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", stopResize);
});

function onKey(e: KeyboardEvent) {
    const cmd = e.metaKey || e.ctrlKey;
    if (cmd && e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSave();
    }
    if (cmd && e.key.toLowerCase() === "w" && state.currentPath) {
        e.preventDefault();
        closeTab(state.currentPath);
    }
    if (e.key === "Escape" && dockState.value === "open") {
        e.preventDefault();
        dockState.value = "dormant";
    }
}

function onContentChange(v: string) {
    if (!currentFile.value) return;
    updateContent(currentFile.value.path, v);
}

async function onSave() {
    await saveAll();
}

async function onCompile() {
    if (!state.taskId || state.files.length === 0) return;
    await saveAll();

    const files = state.files.map(f => ({ path: f.path, content: f.content }));

    // 合并 build 元数据：genTask 现值优先，localStorage 兜底（缓存重载场景 genTask 为空）
    const stored = loadMeta(state.taskId);
    const meta = {
        javaVersion: genTask.javaVersion || stored.javaVersion || "",
        projectName: genTask.projectName || stored.projectName || "",
        packageName: genTask.packageName || stored.packageName || "",
    };
    // 回写一次，保证后续仍可用
    saveMeta(state.taskId, meta);

    // hydrate genTask 让 ChatPage 立刻有 GenerateProgress 可渲染，不再空白
    resetGenTask();
    genTask.taskId = state.taskId;
    genTask.projectName = meta.projectName;
    genTask.packageName = meta.packageName;
    genTask.javaVersion = meta.javaVersion;
    genTask.files = state.files.map(f => ({
        path: f.path,
        role: f.role || "",
        content: f.content,
        status: "done" as const,
        generatorType: f.generatorType ?? undefined,
    }));
    genTask.currentIndex = files.length;
    genTask.phase = "uploading";
    genTask.logs = ["▸ 从 IDE 启动构建，使用本地最新内容..."];

    router.push("/chat");
    // 让 router 完成切换再启动构建，避免在 unmount 期间触发响应
    setTimeout(() => { startBuildFromIDE(files, meta); }, 0);
}

let resizeStartX = 0;
let resizeStartW = 0;
function startResize(e: MouseEvent) {
    resizeStartX = e.clientX;
    resizeStartW = state.sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onResizeMove);
    document.addEventListener("mouseup", stopResize);
}
function onResizeMove(e: MouseEvent) {
    setSidebarWidth(resizeStartW + (e.clientX - resizeStartX));
}
function stopResize() {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", stopResize);
}
</script>

<style scoped>
.ide-page {
  position: fixed;
  inset: 80px 16px 16px;
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  overflow: hidden;
  background: #291E0F;
  border: 1px solid #867053;
  box-shadow: 0 20px 48px rgba(0,0,0,0.42);
  color: rgba(255,255,255,0.85);
}

.ide-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  height: 44px;
  flex-shrink: 0;
  background: #33312C;
  border-bottom: 1px solid #867053;
}
.toolbar-left { display: flex; align-items: center; gap: 12px; }
.toolbar-task { display: inline-flex; align-items: center; gap: 6px; font-family: "Monaco", monospace; font-size: 12px; }
.task-label { color: rgba(255,255,255,0.35); font-size: 10px; text-transform: uppercase; letter-spacing: 0; }
.task-id { color: rgba(255,255,255,0.85); padding: 2px 8px; background: rgba(255,255,255,0.05); border-radius: 5px; }
.toolbar-task.placeholder { color: rgba(255,255,255,0.3); font-style: italic; }
.toolbar-dirty {
  display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: wheat;
  padding: 3px 8px; border-radius: 5px;
  background: rgba(175,152,118,0.12); border: 1px solid rgba(134,112,83,0.52);
}
.toolbar-pom {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: "Monaco", monospace; font-size: 11px;
  padding: 3px 8px; border-radius: 5px;
  background: rgba(130,170,255,0.08); border: 1px solid rgba(130,170,255,0.18);
  color: #82aaff;
}
.toolbar-pom.pom-done { background: rgba(105,214,160,0.08); border-color: rgba(105,214,160,0.18); color: #69d6a0; }
.toolbar-pom.pom-error { background: rgba(255,120,120,0.08); border-color: rgba(255,120,120,0.2); color: #ff9999; }
.pom-spinner {
  width: 8px; height: 8px; border-radius: 50%;
  border: 1.5px solid currentColor; border-top-color: transparent;
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.dirty-mark { font-size: 8px; animation: blink 2s ease-in-out infinite; }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.toolbar-right { display: flex; gap: 8px; }
.tb-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 14px; font-size: 12px; border-radius: 7px;
  background: #291E0F; color: rgba(255,255,255,0.85);
  border: 1px solid #867053; cursor: pointer;
  transition: all 0.15s; font-family: inherit;
}
.tb-btn:hover:not(:disabled) { background: #33312C; border-color: #AF9876; }
.tb-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.tb-btn.primary { background: #AF9876; color: #291E0F; border-color: #AF9876; font-weight: 600; }
.tb-btn.primary:hover:not(:disabled) { background: #AF9876; border-color: #AF9876; filter: brightness(1.08); }

.ide-body {
  flex: 1;
  display: flex;
  min-height: 0;
  position: relative;
}
.code-stage { position: absolute; inset: 0; display: flex; min-height: 0; }
.bp-stage { position: absolute; inset: 0; display: flex; min-height: 0; }

/* 进入蓝图：代码舞台塌缩成左上角小长方形并淡出 */
.collapse-leave-active { transition: transform 0.38s cubic-bezier(0.5,0,0.2,1), opacity 0.34s ease; transform-origin: top left; z-index: 3; }
.collapse-leave-to { transform: scale(0.1); opacity: 0; }
.collapse-enter-active { transition: transform 0.42s cubic-bezier(0.32,0.72,0.24,1) 0.1s, opacity 0.4s ease 0.1s; transform-origin: top left; z-index: 3; }
.collapse-enter-from { transform: scale(0.1); opacity: 0; }
/* 蓝图舞台：紧随其后从左滑入 */
.bpenter-enter-active { transition: opacity 0.44s ease 0.14s, transform 0.44s cubic-bezier(0.32,0.72,0.24,1) 0.14s; }
.bpenter-enter-from { opacity: 0; transform: translateX(-30px) scale(0.98); }
.bpenter-leave-active { transition: opacity 0.2s ease; }
.bpenter-leave-to { opacity: 0; }

.ide-sidebar { flex-shrink: 0; min-width: 180px; max-width: 600px; display: flex; overflow: hidden; }
.ide-resizer {
  flex: 0 0 4px; background: transparent; cursor: col-resize;
  position: relative; z-index: 5; transition: background 0.2s;
}
.ide-resizer:hover { background: #867053; }
.ide-resizer:active { background: #AF9876; }

.ide-editor-col { flex: 1; display: flex; flex-direction: column; min-width: 0; position: relative; }
.empty-editor { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.empty-art { font-size: 56px; color: rgba(245,222,179,0.12); }
.empty-text { color: rgba(255,255,255,0.5); font-size: 14px; }
.empty-hint { color: rgba(255,255,255,0.25); font-size: 11px; font-family: "Monaco", monospace; letter-spacing: 0; }

.ide-statusbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 14px; height: 24px; flex-shrink: 0;
  background: #33312C;
  border-top: 1px solid #867053;
  font-size: 11px; font-family: "Monaco", monospace; color: rgba(255,255,255,0.7);
}
.sb-left, .sb-right { display: flex; align-items: center; gap: 14px; }
.sb-item { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.sb-icon { color: rgba(245,222,179,0.7); }
.sb-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; }
</style>

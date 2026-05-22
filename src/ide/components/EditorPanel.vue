<template>
  <div class="editor-wrap">
    <div class="breadcrumbs" v-if="path" ref="breadEl">
      <span class="crumb-name">{{ baseName }}</span>
      <span v-if="role" class="crumb-role">{{ role }}</span>
      <span v-else class="crumb-path" :title="path">{{ shortPath }}</span>
      <span class="crumb-flex"></span>
      <span class="crumb-lang">{{ language }}</span>
    </div>
    <div class="editor-area">
      <div ref="container" class="editor-mount"></div>
      <SelectionPopup :visible="popupVisible"
                      :snippet="popupSnippet"
                      :context-path="path"
                      :position="popupPos"
                      :max-height="popupMaxH"
                      @close="popupVisible = false"
                      @apply="onApplyToSelection"
                      @undo="onUndoApply"/>
    </div>
    <div v-if="!path" class="editor-empty">
      <div class="empty-art">⌘</div>
      <div class="empty-text">从左侧选择一个文件开始编辑</div>
      <div class="empty-hint">支持 Java · YAML · XML · JSON · Properties</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {ref, onMounted, onBeforeUnmount, watch, shallowRef, computed} from "vue";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import {registerTahaiTheme, TAHAI_THEME} from "../composables/useMonacoTheme";
import {registerBukkitCompletion, findDefinition} from "../composables/useBukkitDict";
import {useIDEStore} from "../composables/useIDEStore";
import SelectionPopup from "./SelectionPopup.vue";
import {nextTick} from "vue";

(self as any).MonacoEnvironment ??= {
    getWorker: () => new EditorWorker(),
};

const props = defineProps<{
    path: string;
    modelValue: string;
    role?: string;
    bottomGutter?: number;
}>();
const emit = defineEmits<{
    (e: "update:modelValue", v: string): void;
    (e: "cursor", line: number, col: number): void;
}>();

const container = ref<HTMLElement | null>(null);
const breadEl = ref<HTMLElement | null>(null);
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor | null>(null);
let suppressChange = false;

// 选区浮层状态
const popupVisible = ref(false);
const popupSnippet = ref("");
const popupPos = ref({left: 0, top: 0});
const popupMaxH = ref(380);
const POPUP_W = 380;
const POPUP_MIN_H = 180;
const POPUP_IDEAL_H = 380;
const GAP = 6;
const EDGE_PAD = 8;
let suppressSelectionN = 0;
let mouseSelecting = false;

const language = ref("plaintext");
const baseName = computed(() => props.path.split("/").pop() || props.path);
const shortPath = computed(() => {
    const parts = props.path.split("/");
    if (parts.length <= 2) return parts.slice(0, -1).join("/");
    return parts.slice(0, -1).join("/");
});

function detectLang(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
        java: "java", kt: "kotlin", xml: "xml", yml: "yaml", yaml: "yaml",
        json: "json", md: "markdown", properties: "ini", gradle: "groovy",
        js: "javascript", ts: "typescript", html: "html", css: "css",
    };
    return map[ext] || "plaintext";
}

const ideStore = useIDEStore();

onMounted(() => {
    if (!container.value) return;
    registerTahaiTheme();
    registerBukkitCompletion();
    editor.value = monaco.editor.create(container.value, {
        value: props.modelValue,
        language: detectLang(props.path),
        theme: TAHAI_THEME,
        fontSize: 13,
        fontFamily: "'Monaco', 'Menlo', 'JetBrains Mono', monospace",
        fontLigatures: true,
        lineHeight: 1.65,
        letterSpacing: 0.2,
        minimap: {enabled: false},
        scrollBeyondLastLine: true,
        automaticLayout: true,
        tabSize: 4,
        insertSpaces: true,
        renderWhitespace: "selection",
        renderLineHighlight: "all",
        smoothScrolling: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        bracketPairColorization: {enabled: true},
        guides: {indentation: true, bracketPairs: true, highlightActiveIndentation: true},
        stickyScroll: {enabled: true, maxLineCount: 4},
        padding: {top: 14, bottom: props.bottomGutter ?? 80},
        roundedSelection: true,
        contextmenu: true,
        scrollbar: {verticalScrollbarSize: 10, horizontalScrollbarSize: 10},
        overviewRulerLanes: 0,
        overviewRulerBorder: false,
    });
    language.value = detectLang(props.path);
    editor.value.onDidChangeModelContent(() => {
        if (suppressChange) return;
        emit("update:modelValue", editor.value!.getValue());
    });
    editor.value.onDidChangeCursorPosition((e) => {
        emit("cursor", e.position.lineNumber, e.position.column);
    });
    editor.value.onDidChangeCursorSelection((e) => {
        if (suppressSelectionN > 0) {
            suppressSelectionN--;
            return;
        }
        // 鼠标拖选过程中先收起浮层，等抬起左键再统一显示
        if (mouseSelecting) {
            popupVisible.value = false;
            return;
        }
        updatePopup(e.selection);
    });
    editor.value.onMouseDown((e) => {
        // Cmd/Ctrl + 左键点 → 尝试跳转定义
        if (e.event.leftButton && (e.event.ctrlKey || e.event.metaKey)) {
            const tgt = e.target;
            if (tgt.type === monaco.editor.MouseTargetType.CONTENT_TEXT && tgt.position) {
                const word = editor.value!.getModel()?.getWordAtPosition(tgt.position);
                if (word) {
                    const found = findDefinition(word.word, props.path);
                    if (found) {
                        e.event.preventDefault?.();
                        mouseSelecting = false;
                        jumpToDefinition(found);
                        return;
                    }
                }
            }
        }
        if (e.event.leftButton) {
            mouseSelecting = true;
            popupVisible.value = false;
        }
    });
    editor.value.onMouseUp(() => {
        if (!mouseSelecting) return;
        mouseSelecting = false;
        const sel = editor.value?.getSelection();
        if (sel) updatePopup(sel);
    });
    editor.value.onDidScrollChange(() => {
        if (popupVisible.value) {
            const sel = editor.value!.getSelection();
            if (sel) updatePopup(sel);
        }
    });
    // 防止拖到编辑器外才松手：全局 mouseup 兜底
    window.addEventListener("mouseup", onGlobalMouseUp);
});

function updatePopup(sel: monaco.Selection) {
    if (!editor.value || !container.value) return;
    const model = editor.value.getModel();
    if (!model) { popupVisible.value = false; return; }
    if (sel.isEmpty()) { popupVisible.value = false; return; }
    const text = model.getValueInRange(sel);
    if (text.trim().length < 4) { popupVisible.value = false; return; }

    // 选区起点用于翻转到上方，终点用于贴下方
    const endVis = editor.value.getScrolledVisiblePosition({
        lineNumber: sel.endLineNumber,
        column: sel.endColumn,
    });
    const startVis = editor.value.getScrolledVisiblePosition({
        lineNumber: sel.startLineNumber,
        column: sel.startColumn,
    });
    if (!endVis || !startVis) { popupVisible.value = false; return; }

    const rect = container.value.getBoundingClientRect();
    const containerH = rect.height;
    const containerW = rect.width;

    // 计算选区上下两侧的可用高度
    const spaceBelow = containerH - (endVis.top + endVis.height) - GAP - EDGE_PAD;
    const spaceAbove = startVis.top - GAP - EDGE_PAD;

    let top: number;
    let maxH: number;

    if (spaceBelow >= POPUP_MIN_H) {
        // 优先放下方
        top = endVis.top + endVis.height + GAP;
        maxH = Math.min(POPUP_IDEAL_H, spaceBelow);
    } else if (spaceAbove >= POPUP_MIN_H) {
        // 翻到上方
        maxH = Math.min(POPUP_IDEAL_H, spaceAbove);
        top = startVis.top - maxH - GAP;
    } else {
        // 两侧都不够 —— 取大的，并允许覆盖部分选区，保证 popup 完整可用
        if (spaceBelow >= spaceAbove) {
            maxH = Math.max(spaceBelow, POPUP_MIN_H);
            top = containerH - maxH - EDGE_PAD;
        } else {
            maxH = Math.max(spaceAbove, POPUP_MIN_H);
            top = EDGE_PAD;
        }
        // 再 clamp 一次确保不会超出容器
        if (maxH > containerH - 2 * EDGE_PAD) maxH = containerH - 2 * EDGE_PAD;
        if (top + maxH > containerH - EDGE_PAD) top = containerH - maxH - EDGE_PAD;
        if (top < EDGE_PAD) top = EDGE_PAD;
    }

    let left = endVis.left;
    if (left + POPUP_W > containerW - EDGE_PAD) left = containerW - POPUP_W - EDGE_PAD;
    if (left < EDGE_PAD) left = EDGE_PAD;

    popupSnippet.value = text;
    popupPos.value = {left, top};
    popupMaxH.value = maxH;
    popupVisible.value = true;
}

function onApplyToSelection(newCode: string) {
    if (!editor.value) return;
    const sel = editor.value.getSelection();
    if (!sel || sel.isEmpty()) return;
    suppressSelectionN = 2; // executeEdits 可能触发 1-2 次 selection change
    editor.value.executeEdits("ai-popup-apply", [{
        range: sel,
        text: newCode,
        forceMoveMarkers: true,
    }]);
}

function onUndoApply() {
    if (!editor.value) return;
    editor.value.trigger("ai-popup", "undo", null);
    editor.value.focus();
}

async function jumpToDefinition(loc: {path: string; line: number; column: number}) {
    popupVisible.value = false;
    if (loc.path !== props.path) {
        ideStore.openFile(loc.path);
        // 等 watch(() => props.modelValue) 把新内容塞进 editor 后再定位
        await nextTick();
        await nextTick();
    }
    if (!editor.value) return;
    const pos = {lineNumber: loc.line, column: loc.column};
    editor.value.revealPositionInCenterIfOutsideViewport(pos);
    editor.value.setPosition(pos);
    editor.value.focus();
}

onBeforeUnmount(() => {
    window.removeEventListener("mouseup", onGlobalMouseUp);
    editor.value?.dispose();
    editor.value = null;
});

function onGlobalMouseUp() {
    if (!mouseSelecting) return;
    mouseSelecting = false;
    const sel = editor.value?.getSelection();
    if (sel) updatePopup(sel);
}

watch(() => props.path, (p) => {
    if (!editor.value) return;
    const lang = detectLang(p);
    language.value = lang;
    const model = editor.value.getModel();
    if (model) monaco.editor.setModelLanguage(model, lang);
    popupVisible.value = false;
});

watch(() => props.modelValue, (v) => {
    if (!editor.value) return;
    if (v === editor.value.getValue()) return;
    suppressChange = true;
    editor.value.setValue(v ?? "");
    suppressChange = false;
});

watch(() => props.bottomGutter, (g) => {
    if (!editor.value) return;
    editor.value.updateOptions({padding: {top: 14, bottom: g ?? 80}});
});
</script>

<style scoped>
.editor-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
  background: #0d0d0f;
}
.breadcrumbs {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 16px;
  font-family: "Monaco", monospace;
  background: rgba(13, 13, 15, 0.95);
  border-bottom: 1px solid rgba(255,255,255,0.04);
  flex-shrink: 0;
  height: 32px;
  overflow: hidden;
}
.crumb-name {
  color: wheat;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.3px;
  white-space: nowrap;
}
.crumb-role {
  color: rgba(255,255,255,0.55);
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 5px;
  background: rgba(255,255,255,0.04);
  letter-spacing: 0.3px;
  white-space: nowrap;
  font-family: "ZhuoKai", "Monaco", monospace;
}
.crumb-path {
  color: rgba(255,255,255,0.32);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 360px;
}
.crumb-flex { flex: 1; }
.crumb-lang {
  font-size: 10px;
  padding: 1px 8px;
  border-radius: 4px;
  background: rgba(245,222,179,0.1);
  color: wheat;
  text-transform: uppercase;
  letter-spacing: 1px;
  border: 1px solid rgba(245,222,179,0.15);
}
.editor-area {
  flex: 1;
  min-height: 0;
  position: relative;
}
.editor-mount {
  position: absolute;
  inset: 0;
}
.editor-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: rgba(255,255,255,0.3);
  font-size: 13px;
  pointer-events: none;
}
.empty-art {
  font-size: 48px;
  color: rgba(245,222,179,0.15);
  margin-bottom: 8px;
}
.empty-text {
  color: rgba(255,255,255,0.5);
  font-size: 14px;
}
.empty-hint {
  font-size: 11px;
  color: rgba(255,255,255,0.25);
  letter-spacing: 0.5px;
}
</style>

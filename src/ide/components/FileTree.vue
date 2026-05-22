<template>
  <div class="file-tree">
    <div class="tree-header">
      <span class="tree-title">{{ viewMode === "category" ? "代码分类" : "项目结构" }}</span>
      <span class="tree-count">{{ files.length }}</span>
      <div class="view-toggle">
        <span class="vt-btn" :class="{active: viewMode === 'category'}" @click="$emit('changeView', 'category')" title="按生成器分类">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
            <path d="M2 3h12v2H2V3Zm0 4h12v2H2V7Zm0 4h12v2H2v-2Z"/>
          </svg>
        </span>
        <span class="vt-btn" :class="{active: viewMode === 'folder'}" @click="$emit('changeView', 'folder')" title="按目录结构">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
            <path d="M1.5 4.5a1.5 1.5 0 0 1 1.5-1.5h3.379a1.5 1.5 0 0 1 1.06.44L8.5 4.5h5a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-8Z"/>
          </svg>
        </span>
      </div>
    </div>
    <div class="tree-search">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" class="search-icon">
        <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0"/>
      </svg>
      <input v-model="filter" placeholder="搜索文件..." class="search-input"/>
      <span v-if="filter" class="search-clear" @click="filter = ''">×</span>
    </div>

    <div class="tree-body" v-if="flatList.length">
      <!-- 分类视图 -->
      <template v-if="viewMode === 'category'">
        <div v-for="node in flatList" :key="node.key" class="tree-row"
             :class="{active: node.type === 'file' && node.path === currentPath, dirty: node.type === 'file' && node.dirty, 'is-category': node.type === 'category'}"
             :style="{paddingLeft: 8 + node.depth * 14 + 'px'}"
             @click="onClick(node)">
          <template v-if="node.type === 'category'">
            <span class="chevron" :class="{expanded: !node.collapsed}">▸</span>
            <span class="cat-bullet" :style="{background: node.color}"></span>
            <span class="cat-label">{{ node.label }}</span>
            <span class="cat-count">{{ node.count }}</span>
          </template>
          <template v-else>
            <span class="chevron-spacer"></span>
            <FileIcon kind="file" :path="node.path"/>
            <span class="row-name">{{ node.name }}</span>
            <span v-if="node.dirty" class="dirty-dot">●</span>
          </template>
        </div>
      </template>

      <!-- 目录视图 -->
      <template v-else>
        <div v-for="node in flatList" :key="node.key"
             class="tree-row"
             :class="{active: node.type === 'file' && node.path === currentPath, dirty: node.type === 'file' && node.dirty}"
             :style="{paddingLeft: 8 + node.depth * 14 + 'px'}"
             @click="onClick(node)">
          <span v-if="node.type === 'folder'" class="chevron" :class="{expanded: !node.collapsed}">▸</span>
          <span v-else class="chevron-spacer"></span>
          <FileIcon v-if="node.type === 'folder'" :kind="node.collapsed ? 'folder-closed' : 'folder-open'"/>
          <FileIcon v-else kind="file" :path="node.path"/>
          <span class="row-name">{{ node.name }}</span>
          <span v-if="node.type === 'file' && node.dirty" class="dirty-dot">●</span>
        </div>
      </template>
    </div>
    <div v-else class="empty">{{ filter ? "无匹配文件" : "还没有文件" }}</div>
  </div>
</template>

<script setup lang="ts">
import {computed, ref} from "vue";
import type {IDEFile, ViewMode} from "../composables/useIDEStore";
import type {GeneratorType} from "../../logic/generateState";
import FileIcon from "./FileIcon.vue";

type FlatNode =
    | { type: "folder"; key: string; name: string; path: string; depth: number; collapsed: boolean }
    | { type: "file"; key: string; name: string; path: string; depth: number; dirty: boolean; role?: string }
    | { type: "category"; key: string; label: string; color: string; count: number; depth: number; collapsed: boolean };

const props = defineProps<{
    files: IDEFile[];
    currentPath: string;
    collapsedFolders: Record<string, boolean>;
    collapsedCategories: Record<string, boolean>;
    viewMode: ViewMode;
}>();

const emit = defineEmits<{
    (e: "select", path: string): void;
    (e: "toggleFolder", path: string): void;
    (e: "toggleCategory", key: string): void;
    (e: "changeView", mode: ViewMode): void;
}>();

const filter = ref("");

const CATEGORY_DEFS: { key: GeneratorType | "FileRelated" | "Other"; label: string; color: string }[] = [
    {key: "MainGen", label: "主类", color: "#f5deb3"},
    {key: "CommandGen", label: "命令", color: "#e7a062"},
    {key: "ListenerGen", label: "事件监听", color: "#82aaff"},
    {key: "TaskGen", label: "调度任务", color: "#c792ea"},
    {key: "ManagerGen", label: "数据 / 服务", color: "#89ddff"},
    {key: "ConfigClassGen", label: "配置类", color: "#a3be8c"},
    {key: "ConfigGen", label: "资源配置", color: "#a3be8c"},
    {key: "ModelGen", label: "数据模型", color: "#ffcb6b"},
    {key: "EnumGen", label: "枚举", color: "#ff9b6a"},
    {key: "UtilGen", label: "工具类", color: "#b3c4d4"},
    {key: "FileRelatedGen", label: "项目文件", color: "#69d6a0"},
    {key: "Other", label: "其他", color: "#666"},
];

function classifyFile(f: IDEFile): string {
    if (f.generatorType) return f.generatorType;
    const ext = f.path.split(".").pop()?.toLowerCase();
    if (ext === "xml" || ext === "yml" || ext === "yaml" || ext === "properties") return "FileRelatedGen";
    return "Other";
}

const flatList = computed<FlatNode[]>(() => {
    const q = filter.value.trim().toLowerCase();
    const filtered = q ? props.files.filter(f => f.path.toLowerCase().includes(q)) : props.files;

    if (props.viewMode === "category") {
        const buckets = new Map<string, IDEFile[]>();
        for (const f of filtered) {
            const k = classifyFile(f);
            if (!buckets.has(k)) buckets.set(k, []);
            buckets.get(k)!.push(f);
        }
        const result: FlatNode[] = [];
        const forceExpand = q.length > 0;
        for (const def of CATEGORY_DEFS) {
            const fs = buckets.get(def.key as string);
            if (!fs || !fs.length) continue;
            const collapsed = !forceExpand && !!props.collapsedCategories[def.key];
            result.push({
                type: "category",
                key: "cat:" + def.key,
                label: def.label,
                color: def.color,
                count: fs.length,
                depth: 0,
                collapsed,
            });
            if (!collapsed) {
                const sorted = [...fs].sort((a, b) => a.path.localeCompare(b.path));
                for (const f of sorted) {
                    result.push({
                        type: "file",
                        key: "f:" + f.path,
                        name: f.path.split("/").pop() || f.path,
                        path: f.path,
                        depth: 1,
                        dirty: f.dirty,
                        role: f.role,
                    });
                }
            }
        }
        return result;
    }

    // folder mode
    type RawNode = { children: Map<string, RawNode>; file?: IDEFile };
    const root: RawNode = {children: new Map()};
    for (const f of filtered) {
        const parts = f.path.split("/");
        let cur = root;
        for (let i = 0; i < parts.length - 1; i++) {
            let next = cur.children.get(parts[i]);
            if (!next) {
                next = {children: new Map()};
                cur.children.set(parts[i], next);
            }
            cur = next;
        }
        cur.children.set(parts[parts.length - 1], {children: new Map(), file: f});
    }
    const result: FlatNode[] = [];
    const forceExpand = q.length > 0;
    const walk = (node: RawNode, depth: number, prefix: string) => {
        const entries = Array.from(node.children.entries()).sort(([na, va], [nb, vb]) => {
            const aIsFolder = !va.file;
            const bIsFolder = !vb.file;
            if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
            return na.localeCompare(nb);
        });
        for (const [name, child] of entries) {
            const fullPath = prefix ? `${prefix}/${name}` : name;
            if (child.file) {
                result.push({
                    type: "file",
                    key: "f:" + child.file.path,
                    name,
                    path: child.file.path,
                    depth,
                    dirty: child.file.dirty,
                    role: child.file.role,
                });
            } else {
                const collapsed = !forceExpand && !!props.collapsedFolders[fullPath];
                result.push({
                    type: "folder",
                    key: "d:" + fullPath,
                    name,
                    path: fullPath,
                    depth,
                    collapsed,
                });
                if (!collapsed) walk(child, depth + 1, fullPath);
            }
        }
    };
    walk(root, 0, "");
    return result;
});

function onClick(node: FlatNode) {
    if (node.type === "folder") emit("toggleFolder", node.path);
    else if (node.type === "category") emit("toggleCategory", node.key.slice(4));
    else emit("select", node.path);
}
</script>

<style scoped>
.file-tree {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: rgba(8, 8, 10, 0.6);
  border-right: 1px solid rgba(255,255,255,0.06);
  min-width: 0;
  width: 100%;
}
.tree-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: 11px;
  color: rgba(255,255,255,0.45);
  text-transform: uppercase;
  letter-spacing: 1px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.tree-count {
  font-family: monospace;
  color: rgba(255,255,255,0.3);
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255,255,255,0.04);
  letter-spacing: 0;
}
.view-toggle {
  margin-left: auto;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: rgba(255,255,255,0.04);
}
.vt-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 20px;
  border-radius: 4px;
  cursor: pointer;
  color: rgba(255,255,255,0.4);
  transition: all 0.15s;
}
.vt-btn:hover { color: rgba(255,255,255,0.7); }
.vt-btn.active {
  background: rgba(245,222,179,0.18);
  color: wheat;
}

.tree-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.search-icon {
  color: rgba(255,255,255,0.3);
  flex-shrink: 0;
}
.search-input {
  flex: 1;
  min-width: 0;
  background: rgba(255,255,255,0.04);
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 4px 8px;
  color: rgba(255,255,255,0.85);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s;
}
.search-input:focus { border-color: rgba(245,222,179,0.3); }
.search-input::placeholder { color: rgba(255,255,255,0.25); }
.search-clear {
  color: rgba(255,255,255,0.4);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 4px;
}
.search-clear:hover { color: wheat; }

.tree-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.tree-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 12px 3px 8px;
  cursor: pointer;
  font-size: 13px;
  color: rgba(255,255,255,0.7);
  user-select: none;
  height: 24px;
  transition: background 0.1s;
}
.tree-row:hover { background: rgba(255,255,255,0.04); }
.tree-row.active {
  background: rgba(245,222,179,0.1);
  color: wheat;
}
.tree-row.active::before {
  content: "";
  position: absolute;
  left: 0;
  width: 2px;
  height: 100%;
  background: wheat;
}
.tree-row.is-category {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1.2px;
  color: rgba(255,255,255,0.55);
  height: 26px;
  margin-top: 4px;
}
.chevron {
  flex-shrink: 0;
  width: 10px;
  font-size: 10px;
  color: rgba(255,255,255,0.4);
  transition: transform 0.15s;
  text-align: center;
}
.chevron.expanded { transform: rotate(90deg); }
.chevron-spacer {
  flex-shrink: 0;
  width: 10px;
}
.cat-bullet {
  display: inline-block;
  width: 11px;
  height: 11px;
  border-radius: 3px;
  flex-shrink: 0;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.25) inset, 0 1px 2px rgba(0,0,0,0.2);
}
.cat-label { flex: 1; }
.cat-count {
  font-family: monospace;
  font-size: 10px;
  color: rgba(255,255,255,0.4);
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255,255,255,0.05);
  letter-spacing: 0;
}
.row-name {
  font-family: "Monaco", monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.dirty-dot {
  color: wheat;
  font-size: 10px;
  flex-shrink: 0;
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: rgba(255,255,255,0.3);
  font-style: italic;
}
</style>

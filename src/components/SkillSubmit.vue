<template>
  <button class="contrib-btn" @click="openModal">+ 贡献 skill</button>

  <Teleport to="body">
    <div v-if="open" class="cs-overlay" @click.self="close">
      <div class="cs-modal glass2">
        <div class="cs-head">
          <span class="cs-title">贡献 skill</span>
          <button class="cs-x" @click="close">✕</button>
        </div>

        <div class="cs-body">
          <!-- 成功态 -->
          <div v-if="result" class="cs-done">
            <div class="cs-done-icon">✓</div>
            <p>已提交，已为你在仓库创建 PR 并 @ 了你的 GitHub 账号。</p>
            <p>审核结果（通过/打回/评论）会通过 GitHub 通知到你。</p>
            <a :href="result" target="_blank" rel="noreferrer" class="cs-pr-link">查看 PR →</a>
          </div>

          <template v-else>
            <!-- 拖拽 / 选择 -->
            <div class="cs-drop" :class="{ over: dragOver }"
                 @dragover.prevent="dragOver = true"
                 @dragleave.prevent="dragOver = false"
                 @drop.prevent="onDrop"
                 @click="fileInput?.click()">
              <input ref="fileInput" type="file" accept=".zip" class="cs-file" @change="onPick"/>
              <div class="cs-drop-main">{{ fileName || "把 skill 的 .zip 拖到这里，或点击选择" }}</div>
              <div class="cs-drop-sub">
                zip 内须含 <code>brief.json</code> + 各 md，目录最多一层。规范见
                <router-link to="/skills" @click="close">技能库 README</router-link>
              </div>
            </div>

            <div v-if="parsing" class="cs-msg">解析中…</div>
            <div v-if="error" class="cs-err">{{ error }}</div>

            <!-- 解析预览 -->
            <div v-if="parsed" class="cs-preview">
              <div class="cs-pv-head">
                <span class="cs-pv-name">{{ parsed.brief.name }}</span>
                <span class="cs-pv-id">{{ parsed.skillId }}</span>
              </div>
              <p v-if="parsed.brief.capability" class="cs-pv-cap">{{ parsed.brief.capability }}</p>
              <div class="cs-pv-files">
                <div class="cs-pv-files-title">{{ parsed.files.length }} 个文件</div>
                <div v-for="f in parsed.files" :key="f.path" class="cs-pv-file">
                  <span class="cs-pv-path">{{ f.path }}</span>
                  <span class="cs-pv-size">{{ fmtSize(f.size) }}</span>
                </div>
              </div>
              <textarea v-model="note" class="cs-note" rows="2" maxlength="500"
                        placeholder="给审核者的备注（可选）"></textarea>
            </div>
          </template>
        </div>

        <div v-if="!result" class="cs-foot">
          <button class="cs-btn ghost" @click="close">取消</button>
          <button class="cs-btn primary" :disabled="!parsed || submitting" @click="submit">
            {{ submitting ? "提交中…" : "提交贡献" }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from "vue";
import JSZip from "jszip";

interface PFile { path: string; content: string; size: number }
interface Parsed { skillId: string; brief: any; files: PFile[] }

const open = ref(false);
const dragOver = ref(false);
const parsing = ref(false);
const error = ref("");
const fileName = ref("");
const parsed = ref<Parsed | null>(null);
const note = ref("");
const submitting = ref(false);
const result = ref("");
const fileInput = ref<HTMLInputElement | null>(null);

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOW_EXT = /\.(md|json|txt|yml|yaml)$/i;
const MAX_FILES = 40, MAX_FILE = 256 * 1024, MAX_TOTAL = 1024 * 1024;

function openModal() { open.value = true; }
function close() {
    open.value = false;
    reset();
}
function reset() {
    dragOver.value = false; parsing.value = false; error.value = "";
    fileName.value = ""; parsed.value = null; note.value = ""; submitting.value = false; result.value = "";
    if (fileInput.value) fileInput.value.value = "";
}

function fmtSize(n: number): string {
    return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function onPick(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) handleZip(f);
}
function onDrop(e: DragEvent) {
    dragOver.value = false;
    const f = e.dataTransfer?.files?.[0];
    if (f) handleZip(f);
}

async function handleZip(file: File) {
    error.value = "";
    parsed.value = null;
    fileName.value = file.name;
    if (!/\.zip$/i.test(file.name)) { error.value = "请选择 .zip 文件"; return; }
    parsing.value = true;
    try {
        const zip = await JSZip.loadAsync(file);
        const all: { path: string; content: string }[] = [];
        const briefPaths: string[] = [];
        const tasks: Promise<void>[] = [];
        zip.forEach((relPath, entry) => {
            if (entry.dir || relPath.includes("__MACOSX") || relPath.split("/").pop()?.startsWith(".")) return;
            tasks.push((async () => {
                const content = await entry.async("string");
                all.push({ path: relPath, content });
                if (relPath === "brief.json" || relPath.endsWith("/brief.json")) briefPaths.push(relPath);
            })());
        });
        await Promise.all(tasks);

        if (!briefPaths.length) { error.value = "压缩包内未找到 brief.json"; return; }
        // 选最浅的 brief.json，其所在目录即 skill 根，去掉外层前缀
        briefPaths.sort((a, b) => a.split("/").length - b.split("/").length);
        const briefPath = briefPaths[0];
        const prefix = briefPath.slice(0, briefPath.length - "brief.json".length); // 含末尾 /（或空）

        const files: PFile[] = all
            .filter((e) => e.path.startsWith(prefix))
            .map((e) => ({ path: e.path.slice(prefix.length), content: e.content, size: new Blob([e.content]).size }))
            .filter((e) => e.path);

        const briefFile = files.find((f) => f.path === "brief.json");
        if (!briefFile) { error.value = "brief.json 解析失败"; return; }
        let brief: any;
        try { brief = JSON.parse(briefFile.content); } catch { error.value = "brief.json 不是合法 JSON"; return; }

        const v = validate(files, brief);
        if (v) { error.value = v; return; }

        parsed.value = { skillId: brief.id, brief, files };
    } catch (e: any) {
        error.value = "解压失败：" + (e?.message || String(e));
    } finally {
        parsing.value = false;
    }
}

function validate(files: PFile[], brief: any): string | null {
    if (!brief.id || !brief.name || !Array.isArray(brief.structure)) return "brief.json 缺少 id / name / structure";
    if (!ID_RE.test(brief.id)) return "brief.json.id 需为小写字母/数字/中划线";
    if (files.length > MAX_FILES) return `文件数超限（最多 ${MAX_FILES}）`;
    let total = 0;
    for (const f of files) {
        if (f.path.includes("..") || f.path.split("/").length > 2) return `非法路径：${f.path}`;
        if (!ALLOW_EXT.test(f.path)) return `不允许的文件类型：${f.path}`;
        if (f.size > MAX_FILE) return `文件过大：${f.path}`;
        total += f.size;
    }
    if (total > MAX_TOTAL) return "总体积超限（最多 1MB）";
    for (const s of brief.structure) {
        if (s?.file && !files.find((f) => f.path === s.file)) return `structure 引用的文件缺失：${s.file}`;
    }
    return null;
}

async function submit() {
    if (!parsed.value) return;
    submitting.value = true;
    error.value = "";
    try {
        const r = await fetch("/api/skills/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                skillId: parsed.value.skillId,
                files: parsed.value.files.map((f) => ({ path: f.path, content: f.content })),
                note: note.value.trim(),
            }),
        });
        if (r.status === 401) { error.value = "请先登录后再贡献"; return; }
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) { error.value = d.error || `提交失败（${r.status}）`; return; }
        result.value = d.prUrl;
    } catch (e: any) {
        error.value = "网络错误：" + (e?.message || String(e));
    } finally {
        submitting.value = false;
    }
}
</script>

<style scoped>
.contrib-btn {
    border: 1px solid rgba(209, 200, 182, 0.24);
    background: rgba(209, 200, 182, 0.045);
    color: #d1c8b6;
    border-radius: 4px;
    padding: 7px 16px;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s, transform 0.15s;
    pointer-events: auto;
}
.contrib-btn:hover { border-color: rgba(198, 176, 125, 0.52); color: #d5c9ac; transform: translateY(-1px); }

.cs-overlay {
    position: fixed;
    inset: 0;
    z-index: 90;
    background: rgba(0, 0, 0, 0.76);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 80px 16px 24px;
}
.cs-modal {
    flex-direction: column;
    width: min(560px, 94vw);
    max-height: 100%;
    border-radius: 8px !important;
    padding: 0 !important;
    overflow: hidden;
    color: #d1c8b6;
}
.cs-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid rgba(209, 200, 182, 0.12);
    flex-shrink: 0;
}
.cs-title { font-size: 17px; font-weight: 700; color: #d5c9ac; }
.cs-x { border: 1px solid rgba(209, 200, 182, 0.14); background: transparent; color: rgba(209, 200, 182, 0.6); font-size: 14px; cursor: pointer; padding: 4px 8px; border-radius: 4px; }
.cs-x:hover { border-color: rgba(209, 200, 182, 0.4); color: #f4f1ec; }

.cs-body { padding: 18px 20px; overflow: auto; }

.cs-drop {
    border: 1px dashed rgba(209, 200, 182, 0.3);
    border-radius: 4px;
    padding: 26px 18px;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
}
.cs-drop.over { border-color: #c6b07d; background: rgba(198, 176, 125, 0.06); }
.cs-file { display: none; }
.cs-drop-main { font-size: 14px; color: #d1c8b6; margin-bottom: 6px; }
.cs-drop-sub { font-size: 12px; color: rgba(209, 200, 182, 0.5); line-height: 1.5; }
.cs-drop-sub code { background: rgba(255, 255, 255, 0.1); padding: 1px 5px; border-radius: 5px; }
.cs-drop-sub a { color: #c6b07d; }

.cs-msg { margin-top: 12px; font-size: 13px; color: rgba(198, 176, 125, 0.72); }
.cs-err { margin-top: 12px; font-size: 13px; color: #ff9a8a; line-height: 1.5; }

.cs-preview { margin-top: 16px; }
.cs-pv-head { display: flex; align-items: baseline; gap: 10px; }
.cs-pv-name { font-size: 16px; font-weight: 700; color: #d5c9ac; }
.cs-pv-id { font-size: 12px; color: rgba(209, 200, 182, 0.5); font-family: "Monaco", monospace; }
.cs-pv-cap { font-size: 13px; line-height: 1.55; color: rgba(209, 200, 182, 0.75); margin-top: 6px; }
.cs-pv-files { margin-top: 12px; border: 1px solid rgba(209, 200, 182, 0.1); border-radius: 4px; overflow: hidden; }
.cs-pv-files-title { font-size: 12px; color: rgba(255, 245, 235, 0.5); padding: 8px 12px; background: rgba(255, 255, 255, 0.03); }
.cs-pv-file { display: flex; justify-content: space-between; padding: 6px 12px; font-size: 12px; border-top: 1px solid rgba(255, 240, 225, 0.06); }
.cs-pv-path { font-family: "Monaco", monospace; color: #f3e7d4; }
.cs-pv-size { color: rgba(255, 245, 235, 0.45); }
.cs-note {
    width: 100%;
    margin-top: 12px;
    background: rgba(0, 0, 0, 0.28);
    border: 1px solid rgba(209, 200, 182, 0.18);
    border-radius: 4px;
    padding: 9px 12px;
    color: #f4f1ec;
    font-size: 13px;
    resize: none;
    outline: none;
}
.cs-note:focus { border-color: #c6b07d; }

.cs-done { text-align: center; padding: 14px 8px; }
.cs-done-icon {
    width: 48px; height: 48px; margin: 0 auto 12px;
    border-radius: 4px; background: #d5c9ac;
    color: #040402; font-size: 26px; line-height: 48px;
}
.cs-done p { font-size: 13px; line-height: 1.6; color: rgba(255, 245, 235, 0.8); }
.cs-pr-link { display: inline-block; margin-top: 14px; color: #c6b07d; font-size: 14px; text-decoration: none; }
.cs-pr-link:hover { text-decoration: underline; }

.cs-foot {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 14px 20px;
    border-top: 1px solid rgba(255, 240, 225, 0.1);
    flex-shrink: 0;
}
.cs-btn {
    border: 1px solid rgba(209, 200, 182, 0.28);
    background: rgba(209, 200, 182, 0.05);
    color: #d1c8b6;
    border-radius: 4px;
    padding: 8px 20px;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.15s;
}
.cs-btn.ghost { background: transparent; opacity: 0.7; }
.cs-btn.ghost:hover { opacity: 1; background: rgba(255, 255, 255, 0.06); }
.cs-btn.primary { background: #d5c9ac; color: #040402; border-color: #e1d8c4; font-weight: 700; }
.cs-btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }
</style>

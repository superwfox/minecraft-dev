// 社区 skill 库前端状态：拉取 /api/skills 列表 + 记住用户已选 skill（有序，localStorage）。
// 选中的 id 由 generateHandler 作为 skillIds 传给规划接口；后端拉取完整 bundle 并注入生成上下文。

import { reactive, ref } from "vue";

export interface SkillStructureItem {
    kind: "gen" | "ref";
    file: string;
    role?: string;
    fileGen?: string;
    depends?: string[];
}

export interface SkillBrief {
    id: string;
    name: string;
    author?: string;
    version?: string;
    description?: string;
    capability?: string;
    tags?: string[];
    coreTypes?: string[];
    mcVersions?: string[];
    expectedGlobals?: Record<string, string>;
    structure?: SkillStructureItem[];
}

const SELECTED_KEY = "tahai-skills";

interface SkillsState {
    loaded: boolean;
    loading: boolean;
    readme: string;
    all: SkillBrief[];
    error: string;
}

export const skillsState = reactive<SkillsState>({
    loaded: false, loading: false, readme: "", all: [], error: "",
});

// ── 已选 skill id（有序 = 手牌顺序），localStorage 持久化 ──
function loadSelected(): string[] {
    try {
        const raw = localStorage.getItem(SELECTED_KEY);
        if (raw) {
            const a = JSON.parse(raw);
            if (Array.isArray(a)) return a.filter((x) => typeof x === "string");
        }
    } catch { /* ignore */ }
    return [];
}

export const selected = reactive<string[]>(loadSelected());

function persist() {
    try { localStorage.setItem(SELECTED_KEY, JSON.stringify([...selected])); } catch { /* ignore */ }
}

export function isSelected(id: string): boolean {
    return selected.includes(id);
}

export function addSkill(id: string) {
    if (!selected.includes(id)) { selected.push(id); persist(); }
}

export function removeSkill(id: string) {
    const i = selected.indexOf(id);
    if (i >= 0) { selected.splice(i, 1); persist(); }
}

export function toggleSkill(id: string) {
    if (isSelected(id)) removeSkill(id); else addSkill(id);
}

/** 把第 from 张牌移动到第 to 个位置（抽屉拖拽排序用）*/
export function moveSkill(from: number, to: number) {
    if (from === to) return;
    if (from < 0 || to < 0 || from >= selected.length || to >= selected.length) return;
    const [x] = selected.splice(from, 1);
    selected.splice(to, 0, x);
    persist();
}

/** 已选 skill 对应的 brief（按 selected 顺序；过滤掉列表里已不存在的 id）*/
export function selectedBriefs(): SkillBrief[] {
    const map = new Map(skillsState.all.map((s) => [s.id, s]));
    return selected
        .map((id) => map.get(id))
        .filter((s): s is SkillBrief => !!s);
}

export function briefById(id: string): SkillBrief | undefined {
    return skillsState.all.find((s) => s.id === id);
}

let inflight: Promise<void> | null = null;

/** 幂等拉取 skill 列表；force=true 强制刷新 */
export function fetchSkills(force = false): Promise<void> {
    if (skillsState.loaded && !force) return Promise.resolve();
    if (inflight) return inflight;
    skillsState.loading = true;
    skillsState.error = "";
    const url = force ? "/api/skills?fresh=1" : "/api/skills";
    // 技能索引本身已有 KV 缓存；浏览器层不再缓存，避免一次降级空响应黏住页面两分钟。
    inflight = fetch(url, { cache: "no-store" })
        .then(async (r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            skillsState.readme = data?.readme || "";
            skillsState.all = Array.isArray(data?.skills) ? data.skills : [];
            skillsState.loaded = true;
        })
        .catch((e) => { skillsState.error = e?.message || "加载失败"; })
        .finally(() => { skillsState.loading = false; inflight = null; });
    return inflight;
}

/** 旧版兼容接口；当前生成链通过请求体中的 skillIds 透传，不再使用请求头。 */
export function skillHeaders(): Record<string, string> {
    return {};
}

// chat 抽屉开关：SkillTray 渲染抽屉，ChatPage 的按钮 toggle
export const trayOpen = ref(false);
export function toggleTray() { trayOpen.value = !trayOpen.value; }

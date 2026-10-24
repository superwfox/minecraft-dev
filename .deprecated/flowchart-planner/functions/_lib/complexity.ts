// 需求复杂度分级：打分向量 + 确定性硬跳变下限。
// 模型给出建议 level，但代码侧用 enforceLevelFloor 强制 level ≥ 硬跳变下限，
// 防止低端/被诱导的模型把「持久化 / 状态共享」判低。
// 见 planReference/plannerComplexity.md。

export type Level = "直接" | "简单" | "中等" | "复杂";
export const LEVELS: Level[] = ["直接", "简单", "中等", "复杂"];

export interface ScoreVector {
    // 广度轴（不抬等级，只影响 plan 体量 / 图大小）
    triggers: number | string;        // 1 | "2-3" | "4+"
    features: number;
    branches: number;                 // 条件分支数（含无状态分支）
    ui: "none" | "command" | "gui_static" | "gui_session";
    // 深度轴（触发等级下限）
    state_lifecycle: "none" | "memory" | "persistent"; // persistent=跨重启需存储
    state_scope: "none" | "player" | "global" | "cross";
    temporality: "instant" | "scheduled" | "continuous";
    state_shared: boolean;            // ≥2 个功能/task 读写同一份可变状态
    external_deps: string[];          // Paper 硬集成：["Vault"] 等
}

function idx(l: Level): number { return LEVELS.indexOf(l); }
function maxLevel(a: Level, b: Level): Level { return idx(a) >= idx(b) ? a : b; }

/** 按 plannerComplexity.md 的硬跳变表算确定性下限（命中即设下限，后者覆盖前者） */
export function floorLevel(v: ScoreVector): Level {
    let floor: Level = "直接";
    const bump = (l: Level) => { floor = maxLevel(floor, l); };

    const ext = Array.isArray(v.external_deps) ? v.external_deps.length : 0;

    // ≥2 条分支（含无状态分支）→ 简单
    if ((v.branches ?? 0) >= 2) bump("简单");
    // memory 或 gui_static → 简单
    if (v.state_lifecycle === "memory" || v.ui === "gui_static") bump("简单");
    // persistent → 中等
    if (v.state_lifecycle === "persistent") bump("中等");
    // 全局 / 跨世界跨服 → 中等（md 列 global，cross 更重，一并顶到中等）
    if (v.state_scope === "global" || v.state_scope === "cross") bump("中等");
    // 定时 / 持续 task → 中等
    if (v.temporality === "scheduled" || v.temporality === "continuous") bump("中等");
    // gui_session → 中等
    if (v.ui === "gui_session") bump("中等");
    // 单个外部硬集成 → 中等
    if (ext >= 1) bump("中等");
    // 状态共享 → 复杂
    if (v.state_shared === true) bump("复杂");
    // ≥2 外部硬集成 → 复杂
    if (ext >= 2) bump("复杂");

    return floor;
}

/** 最终 level = max(模型建议, 硬跳变下限) */
export function enforceLevelFloor(modelLevel: Level | string, v: ScoreVector): Level {
    const m: Level = (LEVELS as string[]).includes(modelLevel as string) ? (modelLevel as Level) : "直接";
    return maxLevel(m, floorLevel(v));
}

/** 点亮的「需 plan 强制交代」的深度轴（喂给 plannerPrompt 的 gradeContext） */
export function litAxes(v: ScoreVector): string[] {
    const out: string[] = [];
    if (v.state_lifecycle === "persistent") out.push("persistent");
    if (v.temporality === "scheduled" || v.temporality === "continuous") out.push("task");
    if (v.state_shared === true) out.push("state_shared");
    if (Array.isArray(v.external_deps) && v.external_deps.length > 0) out.push("external");
    if (v.ui === "gui_session") out.push("gui_session");
    return out;
}

// 针脚 / 节点配色 —— 沿用 IDE 分类色板,按数据类型着色 data 针脚与连线。

import { simpleType } from "./model";
import { CATEGORY_COLOR } from "./curated";

export const EXEC_COLOR = "#ffffff";

export function typeColor(t?: string): string {
    const s = simpleType(t);
    if (!s) return "#b3c4d4";
    if (["boolean", "Boolean"].includes(s)) return "#ff6a6a";
    if (["int", "long", "double", "float", "short", "byte", "char", "Integer", "Long", "Double", "Float"].includes(s)) return "#89ddff";
    if (["String", "CharSequence"].includes(s)) return "#e7a062";
    if (["Player", "HumanEntity", "OfflinePlayer", "CommandSender"].includes(s)) return "#f5deb3";
    if (["Entity", "LivingEntity", "Mob", "Monster", "Animals"].includes(s)) return "#82aaff";
    if (["Block", "World", "Location", "Chunk"].includes(s)) return "#a3be8c";
    if (["ItemStack", "Material", "Inventory", "ItemMeta"].includes(s)) return "#ffcb6b";
    if (["Collection", "List", "Set", "Iterable", "Map"].includes(s)) return "#c792ea";
    if (["Action", "Event", "Cancellable"].includes(s)) return "#ff9b6a";
    return "#b3c4d4";
}

export function categoryColor(cat: string): string {
    return CATEGORY_COLOR[cat] || "#7a8aa0";
}

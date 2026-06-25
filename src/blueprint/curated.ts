// 策展 Paper 节点包 —— 高频子集(bluemap §3.1「Paper 默认包必须策展,非反射全集」)。
// 成员方法节点由 jar 符号按需派生(registry.ts);此处是事件根 / 控制流 / 生命周期 /
// 常用动作 / 数值 / cast 等手写策展。

import type { NodeDef, PinDef } from "./model";

const ex = (id: string, name: string, direction: "in" | "out"): PinDef =>
    ({ id, name, direction, pinKind: "exec" });
const dt = (id: string, name: string, direction: "in" | "out", dataType: string): PinDef =>
    ({ id, name, direction, pinKind: "data", dataType });

// 类别(左侧面板分组,数量大致均摊)
export const CATEGORIES = ["事件", "流程", "玩家", "世界", "物品", "数值", "转换"] as const;

export const CATEGORY_COLOR: Record<string, string> = {
    "事件": "#82aaff",
    "流程": "#c792ea",
    "玩家": "#f5deb3",
    "世界": "#a3be8c",
    "物品": "#ffcb6b",
    "数值": "#b3c4d4",
    "转换": "#ff9b6a",
    "变量": "#89ddff",
};

export const CURATED: NodeDef[] = [
    // ── 事件根(入口,仅 exec-out + data-out)──────────────────────
    {
        type: "event.playerJoin", category: "事件", label: "玩家加入", kind: "impure", special: "event-root",
        desc: "PlayerJoinEvent",
        pins: [ex("then", "▷", "out"), dt("player", "玩家", "out", "Player"), dt("joinMessage", "加入消息", "out", "String")],
    },
    {
        type: "event.playerQuit", category: "事件", label: "玩家离开", kind: "impure", special: "event-root",
        desc: "PlayerQuitEvent",
        pins: [ex("then", "▷", "out"), dt("player", "玩家", "out", "Player"), dt("quitMessage", "离开消息", "out", "String")],
    },
    {
        type: "event.playerInteract", category: "事件", label: "玩家交互(右键/左键)", kind: "impure", special: "event-root",
        desc: "PlayerInteractEvent",
        pins: [ex("then", "▷", "out"), dt("player", "玩家", "out", "Player"), dt("action", "动作", "out", "Action"), dt("item", "手持物品", "out", "ItemStack"), dt("block", "点击方块", "out", "Block")],
    },
    {
        type: "event.blockBreak", category: "事件", label: "破坏方块", kind: "impure", special: "event-root",
        desc: "BlockBreakEvent",
        pins: [ex("then", "▷", "out"), dt("player", "玩家", "out", "Player"), dt("block", "方块", "out", "Block")],
    },
    {
        type: "event.entityDamage", category: "事件", label: "实体受伤", kind: "impure", special: "event-root",
        desc: "EntityDamageEvent",
        pins: [ex("then", "▷", "out"), dt("entity", "实体", "out", "Entity"), dt("damage", "伤害", "out", "double")],
    },
    {
        type: "event.playerDeath", category: "事件", label: "玩家死亡", kind: "impure", special: "event-root",
        desc: "PlayerDeathEvent",
        pins: [ex("then", "▷", "out"), dt("player", "玩家", "out", "Player"), dt("deathMessage", "死亡消息", "out", "String")],
    },
    {
        type: "event.asyncChat", category: "事件", label: "玩家聊天", kind: "impure", special: "event-root",
        desc: "AsyncPlayerChatEvent",
        pins: [ex("then", "▷", "out"), dt("player", "玩家", "out", "Player"), dt("message", "消息", "out", "String")],
    },

    // ── 生命周期 ────────────────────────────────────────────────
    { type: "life.onEnable", category: "事件", label: "插件启用", kind: "impure", special: "lifecycle", desc: "onEnable()", pins: [ex("then", "▷", "out")] },
    { type: "life.onDisable", category: "事件", label: "插件禁用", kind: "impure", special: "lifecycle", desc: "onDisable()", pins: [ex("then", "▷", "out")] },

    // ── 控制流 ──────────────────────────────────────────────────
    {
        type: "flow.branch", category: "流程", label: "分支(if)", kind: "impure", special: "control-flow",
        pins: [ex("exec", "▷", "in"), dt("condition", "条件", "in", "boolean"), ex("true", "真", "out"), ex("false", "假", "out")],
    },
    {
        type: "flow.forEachPlayer", category: "流程", label: "遍历在线玩家", kind: "impure", special: "control-flow",
        pins: [ex("exec", "▷", "in"), ex("loop", "循环体", "out"), dt("player", "玩家", "out", "Player"), ex("done", "完成", "out")],
    },
    {
        type: "flow.forEach", category: "流程", label: "遍历集合", kind: "impure", special: "control-flow",
        pins: [ex("exec", "▷", "in"), dt("list", "集合", "in", "Collection"), ex("loop", "循环体", "out"), dt("item", "元素", "out", "Object"), ex("done", "完成", "out")],
    },
    {
        type: "flow.sequence", category: "流程", label: "顺序执行", kind: "impure", special: "control-flow",
        pins: [ex("exec", "▷", "in"), ex("0", "① ", "out"), ex("1", "② ", "out"), ex("2", "③ ", "out")],
    },
    {
        type: "flow.delay", category: "流程", label: "延迟(tick)", kind: "impure", special: "control-flow",
        desc: "调度器延迟", pins: [ex("exec", "▷", "in"), dt("ticks", "tick 数", "in", "long"), ex("then", "▷", "out")],
    },

    // ── 玩家动作 ────────────────────────────────────────────────
    {
        type: "action.sendMessage", category: "玩家", label: "发送消息", kind: "impure", special: "action",
        pins: [ex("exec", "▷", "in"), dt("target", "对象", "in", "CommandSender"), dt("message", "消息", "in", "String"), ex("then", "▷", "out")],
    },
    {
        type: "action.kick", category: "玩家", label: "踢出玩家", kind: "impure", special: "action",
        pins: [ex("exec", "▷", "in"), dt("player", "玩家", "in", "Player"), dt("reason", "原因", "in", "String"), ex("then", "▷", "out")],
    },
    {
        type: "action.teleport", category: "玩家", label: "传送", kind: "impure", special: "action",
        pins: [ex("exec", "▷", "in"), dt("target", "实体", "in", "Entity"), dt("location", "目标位置", "in", "Location"), ex("then", "▷", "out")],
    },
    {
        type: "action.setHealth", category: "玩家", label: "设置血量", kind: "impure", special: "action",
        pins: [ex("exec", "▷", "in"), dt("entity", "实体", "in", "LivingEntity"), dt("health", "血量", "in", "double"), ex("then", "▷", "out")],
    },
    {
        type: "action.giveItem", category: "物品", label: "给予物品", kind: "impure", special: "action",
        pins: [ex("exec", "▷", "in"), dt("player", "玩家", "in", "Player"), dt("item", "物品", "in", "ItemStack"), ex("then", "▷", "out")],
    },

    // ── 世界动作 ────────────────────────────────────────────────
    {
        type: "action.broadcast", category: "世界", label: "全服广播", kind: "impure", special: "action",
        pins: [ex("exec", "▷", "in"), dt("message", "消息", "in", "String"), ex("then", "▷", "out")],
    },
    {
        type: "action.runCommand", category: "世界", label: "以控制台执行命令", kind: "impure", special: "action",
        pins: [ex("exec", "▷", "in"), dt("command", "命令", "in", "String"), ex("then", "▷", "out")],
    },
    {
        type: "action.dropItem", category: "世界", label: "掉落物品", kind: "impure", special: "action",
        pins: [ex("exec", "▷", "in"), dt("location", "位置", "in", "Location"), dt("item", "物品", "in", "ItemStack"), ex("then", "▷", "out")],
    },
    {
        type: "action.cancelEvent", category: "世界", label: "取消事件", kind: "impure", special: "action",
        desc: "setCancelled(true)", pins: [ex("exec", "▷", "in"), dt("event", "事件", "in", "Cancellable"), ex("then", "▷", "out")],
    },

    // ── 数值 / 字面量 / 纯函数 ───────────────────────────────────
    { type: "value.stringLiteral", category: "数值", label: "文本", kind: "pure", special: "literal", pins: [dt("value", "文本", "out", "String")] },
    { type: "value.intLiteral", category: "数值", label: "整数", kind: "pure", special: "literal", pins: [dt("value", "整数", "out", "int")] },
    { type: "value.doubleLiteral", category: "数值", label: "小数", kind: "pure", special: "literal", pins: [dt("value", "小数", "out", "double")] },
    { type: "value.boolLiteral", category: "数值", label: "布尔", kind: "pure", special: "literal", pins: [dt("value", "真/假", "out", "boolean")] },
    { type: "value.onlinePlayers", category: "玩家", label: "在线玩家集合", kind: "pure", pins: [dt("players", "玩家集合", "out", "Collection")] },
    { type: "value.playerName", category: "玩家", label: "玩家名", kind: "pure", pins: [dt("player", "玩家", "in", "Player"), dt("name", "名字", "out", "String")] },
    { type: "value.concat", category: "数值", label: "拼接文本", kind: "pure", pins: [dt("a", "A", "in", "String"), dt("b", "B", "in", "String"), dt("result", "结果", "out", "String")] },
    { type: "value.equals", category: "数值", label: "相等?", kind: "pure", pins: [dt("a", "A", "in", "Object"), dt("b", "B", "in", "Object"), dt("result", "结果", "out", "boolean")] },
    { type: "value.greaterThan", category: "数值", label: "大于?", kind: "pure", pins: [dt("a", "A", "in", "double"), dt("b", "B", "in", "double"), dt("result", "A>B", "out", "boolean")] },
    { type: "value.not", category: "数值", label: "取反(!)", kind: "pure", pins: [dt("in", "输入", "in", "boolean"), dt("out", "输出", "out", "boolean")] },
    { type: "value.hasPermission", category: "玩家", label: "有权限?", kind: "pure", pins: [dt("sender", "对象", "in", "CommandSender"), dt("permission", "权限节点", "in", "String"), dt("result", "结果", "out", "boolean")] },

    // ── cast(类型窄化,bluemap §3.4;本期手写常用,自动生成留后续)──
    { type: "cast.toPlayer", category: "转换", label: "实体 → 玩家", kind: "pure", special: "cast", pins: [dt("value", "实体", "in", "Entity"), dt("as", "玩家", "out", "Player"), dt("ok", "成功?", "out", "boolean")] },
    { type: "cast.toLiving", category: "转换", label: "实体 → 生物", kind: "pure", special: "cast", pins: [dt("value", "实体", "in", "Entity"), dt("as", "生物", "out", "LivingEntity"), dt("ok", "成功?", "out", "boolean")] },
];

// 字面量节点的默认值占位(literals 初值)
export const LITERAL_DEFAULTS: Record<string, { pin: string; value: string }> = {
    "value.stringLiteral": { pin: "value", value: "文本" },
    "value.intLiteral": { pin: "value", value: "0" },
    "value.doubleLiteral": { pin: "value", value: "0.0" },
    "value.boolLiteral": { pin: "value", value: "true" },
};

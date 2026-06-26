// 策展节点包 —— 只放「结构入口 + 蓝图运算原语 + 极少量全局便利」。
// 对象方法(Player.sendMessage / Location.add …)不再手写,改由 jar 符号按真实
// 字节码派生(registry.memberDefsForType / allMemberDefs),从针脚拖线或右键搜索得到。
// 这样既符合 bluemap §3.1「Paper 默认包须策展、不铺全量」,又保证方法签名准确。

import type { NodeDef, PinDef } from "./model";

const ex = (id: string, name: string, direction: "in" | "out"): PinDef =>
    ({ id, name, direction, pinKind: "exec" });
const dt = (id: string, name: string, direction: "in" | "out", dataType: string, accessor?: string): PinDef =>
    ({ id, name, direction, pinKind: "data", dataType, ...(accessor ? { accessor } : {}) });

// 面板常驻类别(大致均摊)
export const CATEGORIES = ["事件", "流程", "运算", "动作", "转换"] as const;

export const CATEGORY_COLOR: Record<string, string> = {
    "事件": "#82aaff",
    "流程": "#c792ea",
    "运算": "#b3c4d4",
    "动作": "#a3be8c",
    "转换": "#ff9b6a",
    "变量": "#89ddff",
    "函数": "#69d6a0",
    "逃逸": "#bf616a",
};

export const CURATED: NodeDef[] = [
    // ── 事件根 / 生命周期(入口,仅 exec-out + data-out)──────────
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
        pins: [ex("then", "▷", "out"), dt("player", "玩家", "out", "Player"), dt("action", "动作", "out", "Action"), dt("item", "手持物品", "out", "ItemStack"), dt("block", "点击方块", "out", "Block", "getClickedBlock")],
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
        pins: [ex("then", "▷", "out"), dt("player", "玩家", "out", "Player", "getEntity"), dt("deathMessage", "死亡消息", "out", "String")],
    },
    {
        type: "event.asyncChat", category: "事件", label: "玩家聊天", kind: "impure", special: "event-root",
        desc: "AsyncPlayerChatEvent",
        pins: [ex("then", "▷", "out"), dt("player", "玩家", "out", "Player"), dt("message", "消息", "out", "String")],
    },
    {
        type: "event.entityDamageByEntity", category: "事件", label: "实体攻击实体", kind: "impure", special: "event-root",
        desc: "EntityDamageByEntityEvent",
        pins: [ex("then", "▷", "out"), dt("damager", "攻击者", "out", "Entity"), dt("entity", "受害者", "out", "Entity"), dt("damage", "伤害", "out", "double")],
    },
    {
        type: "event.playerMove", category: "事件", label: "玩家移动", kind: "impure", special: "event-root",
        desc: "PlayerMoveEvent",
        pins: [ex("then", "▷", "out"), dt("player", "玩家", "out", "Player"), dt("from", "起点", "out", "Location"), dt("to", "终点", "out", "Location")],
    },
    {
        type: "event.inventoryClick", category: "事件", label: "点击物品栏", kind: "impure", special: "event-root",
        desc: "InventoryClickEvent",
        pins: [ex("then", "▷", "out"), dt("player", "玩家", "out", "Player", "getWhoClicked"), dt("slot", "槽位", "out", "int"), dt("current", "点击物品", "out", "ItemStack", "getCurrentItem")],
    },
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

    // ── 运算原语(蓝图自带,非 Paper API)─────────────────────────
    { type: "value.stringLiteral", category: "运算", label: "文本", kind: "pure", special: "literal", pins: [dt("value", "文本", "out", "String")] },
    { type: "value.intLiteral", category: "运算", label: "整数", kind: "pure", special: "literal", pins: [dt("value", "整数", "out", "int")] },
    { type: "value.doubleLiteral", category: "运算", label: "小数", kind: "pure", special: "literal", pins: [dt("value", "小数", "out", "double")] },
    { type: "value.boolLiteral", category: "运算", label: "布尔", kind: "pure", special: "literal", pins: [dt("value", "真/假", "out", "boolean")] },
    { type: "value.concat", category: "运算", label: "拼接文本", kind: "pure", pins: [dt("a", "A", "in", "String"), dt("b", "B", "in", "String"), dt("result", "结果", "out", "String")] },
    { type: "value.equals", category: "运算", label: "相等?", kind: "pure", pins: [dt("a", "A", "in", "Object"), dt("b", "B", "in", "Object"), dt("result", "结果", "out", "boolean")] },
    { type: "value.greaterThan", category: "运算", label: "大于?", kind: "pure", pins: [dt("a", "A", "in", "double"), dt("b", "B", "in", "double"), dt("result", "A>B", "out", "boolean")] },
    { type: "value.and", category: "运算", label: "与(&&)", kind: "pure", pins: [dt("a", "A", "in", "boolean"), dt("b", "B", "in", "boolean"), dt("result", "结果", "out", "boolean")] },
    { type: "value.or", category: "运算", label: "或(||)", kind: "pure", pins: [dt("a", "A", "in", "boolean"), dt("b", "B", "in", "boolean"), dt("result", "结果", "out", "boolean")] },
    { type: "value.not", category: "运算", label: "取反(!)", kind: "pure", pins: [dt("in", "输入", "in", "boolean"), dt("out", "输出", "out", "boolean")] },

    // ── 全局便利动作(无明确 receiver,留作便利入口)──────────────
    {
        type: "action.broadcast", category: "动作", label: "全服广播", kind: "impure", special: "action",
        desc: "Bukkit.broadcastMessage", pins: [ex("exec", "▷", "in"), dt("message", "消息", "in", "String"), ex("then", "▷", "out")],
    },
    {
        type: "action.runCommand", category: "动作", label: "以控制台执行命令", kind: "impure", special: "action",
        desc: "Bukkit.dispatchCommand(console)", pins: [ex("exec", "▷", "in"), dt("command", "命令", "in", "String"), ex("then", "▷", "out")],
    },
    {
        type: "value.onlinePlayers", category: "动作", label: "在线玩家集合", kind: "pure",
        desc: "Bukkit.getOnlinePlayers", pins: [dt("players", "玩家集合", "out", "Collection")],
    },

    // ── 函数入口 / 出口(学 UE,归「流程」;声明参数 / 返回,针脚随声明动态生成)──
    { type: "fn:in", category: "流程", label: "函数入口(参数)", kind: "impure", special: "fn-in", desc: "在函数图里声明参数;每个参数成为本图的一个输入", pins: [ex("then", "▷", "out")] },
    { type: "fn:out", category: "流程", label: "函数出口(返回)", kind: "impure", special: "fn-out", desc: "在函数图里声明返回值;每个返回成为本图的一个输出", pins: [ex("exec", "▷", "in")] },

    // ── cast(类型窄化,bluemap §3.4;自动生成留后续)──────────────
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

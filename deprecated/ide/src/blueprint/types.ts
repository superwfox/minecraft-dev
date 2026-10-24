// 类型相容性(bluemap §2.3 硬约束:不相容的 data 针脚不得连接)。
// 继承关系优先用 jar 符号(useJarSymbols 已解析 parent/interfaces),
// 叠加一张内置 Bukkit 子类型表,使常见连线在 jar 未加载时也可用。

import { simpleType } from "./model";
import { getDynamicDictStatus } from "../ide/composables/useBukkitDict";

// 直接父类型(简单名 → 直接超类/接口)
const BUILTIN_SUPER: Record<string, string[]> = {
    Player: ["HumanEntity", "CommandSender", "OfflinePlayer", "Entity"],
    HumanEntity: ["LivingEntity"],
    LivingEntity: ["Entity", "Damageable", "Attributable"],
    Damageable: ["Entity"],
    ConsoleCommandSender: ["CommandSender"],
    BlockCommandSender: ["CommandSender"],
    Mob: ["LivingEntity"],
    Monster: ["Mob"],
    Animals: ["Mob"],
    Item: ["Entity"],
    List: ["Collection"],
    Set: ["Collection"],
    Collection: ["Iterable"],
    String: ["CharSequence"],
    PlayerJoinEvent: ["PlayerEvent", "Event"],
    PlayerQuitEvent: ["PlayerEvent", "Event"],
    BlockBreakEvent: ["BlockEvent", "Event", "Cancellable"],
    PlayerInteractEvent: ["PlayerEvent", "Event", "Cancellable"],
    EntityDamageEvent: ["EntityEvent", "Event", "Cancellable"],
    AsyncPlayerChatEvent: ["PlayerEvent", "Event", "Cancellable"],
    PlayerEvent: ["Event"],
    BlockEvent: ["Event"],
    EntityEvent: ["Event"],
};

// 数值拓宽等级
const NUM_RANK: Record<string, number> = {
    byte: 1, short: 2, char: 2, int: 3, long: 4, float: 5, double: 6,
    Byte: 1, Short: 2, Character: 2, Integer: 3, Long: 4, Float: 5, Double: 6,
};
function unbox(t: string): string {
    const map: Record<string, string> = {
        Integer: "int", Long: "long", Double: "double", Float: "float",
        Boolean: "boolean", Byte: "byte", Short: "short", Character: "char",
    };
    return map[t] || t;
}

// ── jar 继承索引(按 classes 数组身份缓存,变了才重建)──
let cacheRef: any = null;
let dynDirect: Map<string, string[]> = new Map();
function dynamicDirect(): Map<string, string[]> {
    const st = getDynamicDictStatus();
    if (st.classes === cacheRef) return dynDirect;
    cacheRef = st.classes;
    const m = new Map<string, string[]>();
    for (const c of st.classes) {
        const name = simpleType(c.fqn);
        const sup: string[] = [];
        if (c.parent) sup.push(simpleType(c.parent));
        for (const i of c.interfaces || []) sup.push(simpleType(i));
        if (sup.length) m.set(name, sup);
    }
    dynDirect = m;
    return m;
}

function directSupers(name: string): string[] {
    const a = BUILTIN_SUPER[name] || [];
    const b = dynamicDirect().get(name) || [];
    return a.length || b.length ? [...new Set([...a, ...b])] : [];
}

// name 的全部祖先(含 Object)
function ancestorsOf(name: string): Set<string> {
    const out = new Set<string>(["Object"]);
    const stack = [name];
    let guard = 0;
    while (stack.length && guard++ < 200) {
        const cur = stack.pop()!;
        for (const s of directSupers(cur)) {
            if (!out.has(s)) { out.add(s); stack.push(s); }
        }
    }
    return out;
}

// from 能否流向 to(子类型 → 父类型针脚)
export function isCompatible(from?: string, to?: string): boolean {
    let f = simpleType(from);
    let t = simpleType(to);
    if (!f || !t) return true;            // 类型未知时放行,避免误拦
    if (t === "Object") return true;
    if (f === t) return true;

    // 数组:逐层对齐
    const fa = f.endsWith("[]"), ta = t.endsWith("[]");
    if (fa || ta) {
        if (fa && ta) return isCompatible(f.slice(0, -2), t.slice(0, -2));
        return false;
    }

    // 数值拓宽
    if (NUM_RANK[f] && NUM_RANK[t]) return NUM_RANK[f] <= NUM_RANK[t];
    // 装箱等价
    if (unbox(f) === unbox(t)) return true;

    // 子类型
    return ancestorsOf(f).has(t);
}

// 两针脚能否连接(exec 只接 exec;data 看类型 + 方向)
export function pinsCompatible(
    a: { pinKind: string; direction: string; dataType?: string },
    b: { pinKind: string; direction: string; dataType?: string },
): boolean {
    if (a.pinKind !== b.pinKind) return false;
    if (a.direction === b.direction) return false; // 必须一进一出
    if (a.pinKind === "exec") return true;
    const out = a.direction === "out" ? a : b;
    const inp = a.direction === "out" ? b : a;
    return isCompatible(out.dataType, inp.dataType);
}

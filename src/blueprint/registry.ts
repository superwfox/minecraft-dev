// 节点注册表(bluemap §3.1 数据驱动、可插拔)。
// = 策展 Paper 包 ∪ jar 符号派生成员节点 ∪(后续)skill 包。本期装前两个。

import type { NodeDef, PinDef, GraphNode, Variable } from "./model";
import { simpleType } from "./model";
import { CURATED } from "./curated";
import { getDynamicDictStatus } from "../ide/composables/useBukkitDict";

// ── 策展包索引 ──────────────────────────────────────────────
const curatedByType = new Map<string, NodeDef>(CURATED.map(d => [d.type, d]));
const extraPacks: NodeDef[] = []; // registerPack 注入(skill 包,本期不调)

export function allCuratedDefs(): NodeDef[] {
    return [...CURATED, ...extraPacks];
}
export function curatedDef(type: string): NodeDef | undefined {
    return curatedByType.get(type) || extraPacks.find(d => d.type === type);
}
export function registerPack(defs: NodeDef[]) {
    for (const d of defs) { extraPacks.push(d); curatedByType.set(d.type, d); }
}

// ── 方法签名解析:"void sendMessage(String message)" ──────────
interface ParsedSig { ret: string; name: string; params: { type: string; name: string }[]; }

function splitParams(s: string): string[] {
    const out: string[] = [];
    let depth = 0, cur = "";
    for (const ch of s) {
        if (ch === "<") depth++;
        else if (ch === ">") depth--;
        if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
        else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
}

function parseSig(sig: string): ParsedSig | null {
    const open = sig.indexOf("(");
    if (open < 0) return null;
    const before = sig.slice(0, open).trim();
    const tokens = before.split(/\s+/);
    const name = tokens.pop() || "";
    const ret = tokens.join(" ") || "void";
    const close = sig.lastIndexOf(")");
    const paramsStr = close > open ? sig.slice(open + 1, close) : "";
    const params = splitParams(paramsStr).map((p, i) => {
        const tk = p.trim().split(/\s+/);
        const pn = tk.length > 1 ? tk.pop()! : `arg${i}`;
        const tp = tk.join(" ") || "Object";
        return { type: tp, name: pn };
    }).filter(p => p.type);
    return { ret, name, params };
}

// 有副作用的方法名前缀 → impure(带 exec);否则按返回值是否 void 判定
const SIDE_EFFECT = /^(set|send|add|remove|run|teleport|kick|give|drop|spawn|play|broadcast|save|reload|register|cancel|open|close|clear|update|apply|damage|strike)/;
function isImpureMethod(name: string, ret: string): boolean {
    if (simpleType(ret) === "void") return true;
    return SIDE_EFFECT.test(name);
}

// ── jar 符号派生成员节点 ────────────────────────────────────
const memberCache = new Map<string, NodeDef[]>();
let memberCacheRef: any = null;

export function memberDefsForType(typeName: string): NodeDef[] {
    const st = getDynamicDictStatus();
    if (st.classes !== memberCacheRef) { memberCache.clear(); memberCacheRef = st.classes; }
    const key = simpleType(typeName);
    const cached = memberCache.get(key);
    if (cached) return cached;

    const cls = st.byName.get(key);
    if (!cls) { memberCache.set(key, []); return []; }

    const defs: NodeDef[] = [];
    const seen = new Set<string>();
    for (const m of cls.members) {
        if (m.kind !== "method") continue;
        const parsed = parseSig(m.signature);
        if (!parsed) continue;
        const sigKey = `${parsed.name}(${parsed.params.map(p => simpleType(p.type)).join(",")})`;
        if (seen.has(sigKey)) continue;
        seen.add(sigKey);

        const impure = isImpureMethod(parsed.name, parsed.ret);
        const pins: PinDef[] = [];
        if (impure) pins.push({ id: "exec", name: "▷", direction: "in", pinKind: "exec" });
        pins.push({ id: "self", name: key, direction: "in", pinKind: "data", dataType: key });
        parsed.params.forEach((p, i) =>
            pins.push({ id: "p" + i, name: p.name, direction: "in", pinKind: "data", dataType: p.type }));
        if (impure) pins.push({ id: "then", name: "▷", direction: "out", pinKind: "exec" });
        if (simpleType(parsed.ret) !== "void")
            pins.push({ id: "ret", name: simpleType(parsed.ret), direction: "out", pinKind: "data", dataType: parsed.ret });

        defs.push({
            type: `member:${key}#${sigKey}`,
            category: key,
            label: `${key}.${parsed.name}`,
            kind: impure ? "impure" : "pure",
            special: "member",
            pins,
            desc: m.signature,
        });
    }
    memberCache.set(key, defs);
    return defs;
}

// 全部已加载类的成员节点 —— 供右键搜索可达真实 Paper 方法(搜索框过滤,不铺全量)
let allMemberCache: NodeDef[] | null = null;
let allMemberRef: any = null;
export function allMemberDefs(): NodeDef[] {
    const st = getDynamicDictStatus();
    if (st.classes === allMemberRef && allMemberCache) return allMemberCache;
    allMemberRef = st.classes;
    const out: NodeDef[] = [];
    for (const name of st.byName.keys()) {
        for (const d of memberDefsForType(name)) out.push(d);
    }
    allMemberCache = out;
    return out;
}

// ── 变量 get/set 定义(动态合成)──────────────────────────────
export function varDef(varName: string, mode: "get" | "set", vars: Variable[]): NodeDef {
    const v = vars.find(x => x.name === varName);
    const dataType = v?.dataType || "Object";
    if (mode === "get") {
        return {
            type: "var:get", category: "变量", label: `取 ${varName}`, kind: "pure", special: "variable",
            pins: [{ id: "value", name: varName, direction: "out", pinKind: "data", dataType }],
        };
    }
    return {
        type: "var:set", category: "变量", label: `设 ${varName}`, kind: "impure", special: "variable",
        pins: [
            { id: "exec", name: "▷", direction: "in", pinKind: "exec" },
            { id: "value", name: varName, direction: "in", pinKind: "data", dataType },
            { id: "then", name: "▷", direction: "out", pinKind: "exec" },
            { id: "out", name: varName, direction: "out", pinKind: "data", dataType },
        ],
    };
}

// ── 把一个 GraphNode 解析为有效 NodeDef ──────────────────────
const UNKNOWN: (type: string) => NodeDef = (type) => ({
    type, category: "未知", label: "未知节点", kind: "pure", pins: [], desc: type,
});

export function resolveDef(node: GraphNode, vars: Variable[]): NodeDef {
    if (node.varRef) return varDef(node.varRef.name, node.varRef.mode, vars);
    return curatedDef(node.defType) || node.inlineDef || UNKNOWN(node.defType);
}

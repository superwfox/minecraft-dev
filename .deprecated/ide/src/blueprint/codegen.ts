// 图 → Java 代码:确定性投影(bluemap §4.1/§4.2),全程无 AI。
// 从事件根 / 生命周期 / 函数入口沿 exec 针脚生成语句;data 针脚递归生成表达式。
// 类型用全限定名内联(v1 跳过 import 管理,始终可编译);未覆盖构造留 TODO,逃逸节点见下一轮。

import type { BlueprintDoc, BlueprintGraph, GraphNode, NodeDef, PinDef } from "./model";
import { simpleType } from "./model";
import { resolveDef } from "./registry";
import { getDynamicDictStatus } from "../ide/composables/useBukkitDict";

// ── 类型 / 字面量 / 标识符工具 ───────────────────────────────
const PRIM = new Set(["int", "long", "double", "float", "boolean", "byte", "short", "char", "void"]);
const LANG = new Set(["String", "Object", "CharSequence", "Number", "Integer", "Long",
    "Double", "Float", "Boolean", "Character", "Byte", "Short"]);

function typeEmit(type?: string): string {
    const s = simpleType(type);
    if (!s) return "Object";
    const dims = (s.match(/\[\]/g) || []).length;
    const base = s.replace(/\[\]/g, "");
    if (PRIM.has(base) || LANG.has(base)) return s;
    const cls = getDynamicDictStatus().byName.get(base);
    return (cls ? cls.fqn : base) + "[]".repeat(dims);
}

function ident(name: string, fallback = "v"): string {
    let s = (name || "").replace(/[^A-Za-z0-9_$]/g, "");
    if (!s || /^[0-9]/.test(s)) s = fallback + s;
    return s;
}

function escapeStr(v: string): string {
    return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

function defaultFor(type?: string): string {
    const s = simpleType(type);
    if (s === "String" || s === "CharSequence") return '""';
    if (s === "boolean" || s === "Boolean") return "false";
    if (["int", "short", "byte", "Integer", "Short", "Byte"].includes(s)) return "0";
    if (["long", "Long"].includes(s)) return "0L";
    if (["double", "float", "Double", "Float"].includes(s)) return "0.0";
    if (s === "char") return "'\\0'";
    return "null";
}

function formatLiteral(raw: string, type?: string): string {
    const s = simpleType(type);
    const t = (raw ?? "").trim();
    if (s === "String" || s === "CharSequence") return `"${escapeStr(raw ?? "")}"`;
    if (s === "boolean" || s === "Boolean") return t === "true" ? "true" : "false";
    if (s === "long" || s === "Long") return /[0-9]$/.test(t) ? t + "L" : (t || "0L");
    if (s === "float" || s === "Float") return t ? t + "f" : "0f";
    if (["int", "short", "byte", "double", "Integer", "Short", "Byte", "Double"].includes(s)) return t || "0";
    // 类型未知:数字 / 布尔 / null 原样,否则当字符串
    if (/^-?\d+(\.\d+)?[LlFfDd]?$/.test(t) || t === "true" || t === "false" || t === "null") return t;
    return `"${escapeStr(raw ?? "")}"`;
}

function accessorFor(pinId: string, type?: string): string {
    const cap = pinId.charAt(0).toUpperCase() + pinId.slice(1);
    const s = simpleType(type);
    return (s === "boolean" || s === "Boolean") ? "is" + cap : "get" + cap;
}

// member:Key#name(params) → name
function memberMethodName(defType: string): string {
    const h = defType.indexOf("#");
    if (h < 0) return "method";
    const p = defType.indexOf("(", h);
    return defType.slice(h + 1, p < 0 ? undefined : p);
}

// ── 表达式 / 语句模板(纯节点 / 全局动作)──────────────────
const EXPR_TEMPLATES: Record<string, string> = {
    "value.concat": "$a + $b",
    "value.equals": "java.util.Objects.equals($a, $b)",
    "value.greaterThan": "($a > $b)",
    "value.and": "($a && $b)",
    "value.or": "($a || $b)",
    "value.not": "(!$in)",
    "value.onlinePlayers": "org.bukkit.Bukkit.getOnlinePlayers()",
};
const STMT_TEMPLATES: Record<string, string> = {
    "action.broadcast": "org.bukkit.Bukkit.broadcastMessage($message);",
    "action.runCommand": "org.bukkit.Bukkit.dispatchCommand(org.bukkit.Bukkit.getConsoleSender(), $command);",
};

// ── 生成器工厂:闭包持有 doc / 函数名表 / 临时量计数 ──────────
function createGen(doc: BlueprintDoc) {
    // 函数图 → Java 方法名(去重)
    const fnName = new Map<string, string>();
    const used = new Set<string>(["onEnable", "onDisable"]);
    for (const g of doc.graphs) {
        if (g.graphType !== "function") continue;
        let base = ident(g.name, "");
        if (!base) base = "fn" + g.id.replace(/[^a-z0-9]/gi, "").slice(0, 6);
        let n = base, i = 2;
        while (used.has(n)) n = base + i++;
        used.add(n);
        fnName.set(g.id, n);
    }

    let localCounter = 0;
    const fresh = (base: string) => ident(base) + ++localCounter;

    // ── 节点定义解析(按所在图,函数/引用节点本地构造)──────
    function buildFnIn(g: BlueprintGraph): NodeDef {
        const pins: PinDef[] = [{ id: "then", name: "▷", direction: "out", pinKind: "exec" }];
        for (const p of g.inputs || []) pins.push({ id: `p:${p.id}`, name: p.name, direction: "out", pinKind: "data", dataType: p.type });
        return { type: "fn:in", category: "流程", label: "函数入口", kind: "impure", special: "fn-in", pins };
    }
    function buildFnOut(g: BlueprintGraph): NodeDef {
        const pins: PinDef[] = [{ id: "exec", name: "▷", direction: "in", pinKind: "exec" }];
        for (const p of g.outputs || []) pins.push({ id: `p:${p.id}`, name: p.name, direction: "in", pinKind: "data", dataType: p.type });
        return { type: "fn:out", category: "流程", label: "函数出口", kind: "impure", special: "fn-out", pins };
    }
    function buildGraphRef(graphId: string): NodeDef {
        const g = doc.graphs.find(x => x.id === graphId);
        const pins: PinDef[] = [
            { id: "exec", name: "▷", direction: "in", pinKind: "exec" },
            { id: "then", name: "▷", direction: "out", pinKind: "exec" },
        ];
        if (g) {
            for (const p of g.inputs || []) pins.push({ id: `in:${p.id}`, name: p.name, direction: "in", pinKind: "data", dataType: p.type });
            for (const p of g.outputs || []) pins.push({ id: `out:${p.id}`, name: p.name, direction: "out", pinKind: "data", dataType: p.type });
        }
        return { type: `graphref:${graphId}`, category: "函数", label: g?.name || "func", kind: "impure", special: "function", pins };
    }
    function defForNode(node: GraphNode, g: BlueprintGraph): NodeDef {
        if (node.defType === "fn:in") return buildFnIn(g);
        if (node.defType === "fn:out") return buildFnOut(g);
        if (node.graphRef) return buildGraphRef(node.graphRef);
        return resolveDef(node, doc.variables);
    }

    // ── 图遍历小工具 ────────────────────────────────────────
    const nodeById = (g: BlueprintGraph, id: string) => g.nodes.find(n => n.id === id) || null;
    const dataIn = (g: BlueprintGraph, node: string, pin: string) =>
        g.edges.find(e => e.pinKind === "data" && e.to.node === node && e.to.pin === pin) || null;
    const execOut = (g: BlueprintGraph, node: string, pin: string) =>
        g.edges.find(e => e.pinKind === "exec" && e.from.node === node && e.from.pin === pin) || null;
    const pinUsed = (g: BlueprintGraph, node: string, pin: string) =>
        g.edges.some(e => e.from.node === node && e.from.pin === pin);

    // ── 表达式:某节点某 out 针脚 → Java 表达式 ──────────────
    function exprOfPin(g: BlueprintGraph, node: GraphNode, pinId: string, bind: Map<string, string>): string {
        const key = node.id + ":" + pinId;
        if (bind.has(key)) return bind.get(key)!;
        const def = defForNode(node, g);
        const sp = def.special;

        if (sp === "literal") {
            const pin = def.pins.find(p => p.id === pinId);
            return formatLiteral(node.literals?.[pinId] ?? "", pin?.dataType);
        }
        if (sp === "variable") return ident(node.varRef?.name || "var");
        if (sp === "fn-in") {
            const inp = (g.inputs || []).find(x => `p:${x.id}` === pinId);
            return inp ? ident(inp.name) : "null";
        }
        if (sp === "event-root") {
            const pin = def.pins.find(p => p.id === pinId);
            return "event." + (pin?.accessor || accessorFor(pinId, pin?.dataType)) + "()";
        }
        if (sp === "cast") {
            const target = typeEmit(def.pins.find(p => p.id === "as")?.dataType);
            const val = argOfIn(g, node, def, "value", bind);
            return pinId === "ok" ? `(${val} instanceof ${target})` : `((${target}) ${val})`;
        }
        if (sp === "member") return memberCall(g, node, def, bind);
        if (sp === "function") return fnCall(g, node, def, bind);
        if (node.defType.startsWith("binop:")) {
            const op = node.defType.slice("binop:".length);
            return `(${argOfIn(g, node, def, "a", bind)} ${op} ${argOfIn(g, node, def, "b", bind)})`;
        }
        if (node.defType.startsWith("field:")) return node.defType.slice("field:".length); // 限定名引用 verbatim

        const tpl = EXPR_TEMPLATES[node.defType];
        if (tpl) return fillTemplate(tpl, g, node, def, bind);

        const pin = def.pins.find(p => p.id === pinId);
        return defaultFor(pin?.dataType);
    }

    // 取某 data-in 针脚的入参表达式(连线 → 源表达式;否则字面量 / 默认值)
    function argOfIn(g: BlueprintGraph, node: GraphNode, def: NodeDef, pinId: string, bind: Map<string, string>): string {
        const pin = def.pins.find(p => p.id === pinId);
        const edge = dataIn(g, node.id, pinId);
        if (edge) {
            const src = nodeById(g, edge.from.node);
            if (src) return exprOfPin(g, src, edge.from.pin, bind);
        }
        const raw = node.literals?.[pinId];
        return raw != null ? formatLiteral(raw, pin?.dataType) : defaultFor(pin?.dataType);
    }

    function fillTemplate(tpl: string, g: BlueprintGraph, node: GraphNode, def: NodeDef, bind: Map<string, string>): string {
        return tpl.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, id) => argOfIn(g, node, def, id, bind));
    }

    function memberCall(g: BlueprintGraph, node: GraphNode, def: NodeDef, bind: Map<string, string>): string {
        const dt = node.defType;
        const args = def.pins
            .filter(p => p.direction === "in" && p.pinKind === "data" && p.id !== "self")
            .map(p => argOfIn(g, node, def, p.id, bind));
        if (dt.startsWith("new:")) return `new ${typeEmit(dt.slice(4, dt.indexOf("(")))}(${args.join(", ")})`;
        if (dt.startsWith("static:")) {
            const recv = dt.slice(7, dt.indexOf("#"));
            const method = memberMethodName(dt);
            return recv ? `${typeEmit(recv)}.${method}(${args.join(", ")})` : `${method}(${args.join(", ")})`;
        }
        const recv = argOfIn(g, node, def, "self", bind);
        return `${recv}.${memberMethodName(dt)}(${args.join(", ")})`;
    }

    function fnCall(g: BlueprintGraph, node: GraphNode, def: NodeDef, bind: Map<string, string>): string {
        const callee = fnName.get(node.graphRef || "") || "func";
        const target = doc.graphs.find(x => x.id === node.graphRef);
        const args = (target?.inputs || []).map(inp => argOfIn(g, node, def, `in:${inp.id}`, bind));
        return `${callee}(${args.join(", ")})`;
    }

    // ── 语句:沿某 exec-out 继续 ─────────────────────────────
    function emitExecOut(g: BlueprintGraph, node: GraphNode, execPin: string, out: string[], ind: number, bind: Map<string, string>, seen: Set<string>) {
        const e = execOut(g, node.id, execPin);
        if (!e) return;
        const t = nodeById(g, e.to.node);
        if (t) emitNode(g, t, out, ind, bind, seen);
    }

    function emitNode(g: BlueprintGraph, node: GraphNode, out: string[], ind: number, bind: Map<string, string>, seen: Set<string>) {
        if (seen.has(node.id)) return; // 防环 / 防重复发射
        seen.add(node.id);
        const def = defForNode(node, g);
        const pad = "    ".repeat(ind);

        switch (node.defType) {
            case "flow.branch": {
                out.push(`${pad}if (${argOfIn(g, node, def, "condition", bind)}) {`);
                emitExecOut(g, node, "true", out, ind + 1, bind, seen);
                if (execOut(g, node.id, "false")) {
                    out.push(`${pad}} else {`);
                    emitExecOut(g, node, "false", out, ind + 1, bind, seen);
                }
                out.push(`${pad}}`);
                return;
            }
            case "flow.forEachPlayer": {
                const lv = fresh("p");
                bind.set(node.id + ":player", lv);
                out.push(`${pad}for (org.bukkit.entity.Player ${lv} : org.bukkit.Bukkit.getOnlinePlayers()) {`);
                emitExecOut(g, node, "loop", out, ind + 1, bind, seen);
                out.push(`${pad}}`);
                emitExecOut(g, node, "done", out, ind, bind, seen);
                return;
            }
            case "flow.forEach": {
                const itemPin = def.pins.find(p => p.id === "item");
                const lv = fresh("item");
                bind.set(node.id + ":item", lv);
                out.push(`${pad}for (${typeEmit(itemPin?.dataType)} ${lv} : ${argOfIn(g, node, def, "list", bind)}) {`);
                emitExecOut(g, node, "loop", out, ind + 1, bind, seen);
                out.push(`${pad}}`);
                emitExecOut(g, node, "done", out, ind, bind, seen);
                return;
            }
            case "flow.sequence": {
                for (const p of def.pins.filter(p => p.direction === "out" && p.pinKind === "exec"))
                    emitExecOut(g, node, p.id, out, ind, bind, seen);
                return;
            }
            case "flow.delay": {
                out.push(`${pad}org.bukkit.Bukkit.getScheduler().runTaskLater(this, () -> {`);
                emitExecOut(g, node, "then", out, ind + 1, bind, seen);
                out.push(`${pad}}, ${argOfIn(g, node, def, "ticks", bind)});`);
                return;
            }
        }

        if (def.special === "variable" && node.varRef?.mode === "set") {
            const name = ident(node.varRef.name);
            out.push(`${pad}${name} = ${argOfIn(g, node, def, "value", bind)};`);
            bind.set(node.id + ":out", name);
            emitExecOut(g, node, "then", out, ind, bind, seen);
            return;
        }
        if (def.special === "fn-out") {
            const outs = g.outputs || [];
            if (outs.length) out.push(`${pad}return ${argOfIn(g, node, def, `p:${outs[0].id}`, bind)};`);
            else out.push(`${pad}return;`);
            return;
        }
        if (STMT_TEMPLATES[node.defType]) {
            out.push(pad + fillTemplate(STMT_TEMPLATES[node.defType], g, node, def, bind));
            emitExecOut(g, node, "then", out, ind, bind, seen);
            return;
        }
        if (def.special === "member") {
            const call = memberCall(g, node, def, bind);
            const ret = def.pins.find(p => p.id === "ret");
            if (ret && pinUsed(g, node.id, "ret")) {
                const t = fresh("r");
                out.push(`${pad}${typeEmit(ret.dataType)} ${t} = ${call};`);
                bind.set(node.id + ":ret", t);
            } else {
                out.push(`${pad}${call};`);
            }
            emitExecOut(g, node, "then", out, ind, bind, seen);
            return;
        }
        if (def.special === "function") {
            const call = fnCall(g, node, def, bind);
            const target = doc.graphs.find(x => x.id === node.graphRef);
            const outs = target?.outputs || [];
            if (outs.length && pinUsed(g, node.id, `out:${outs[0].id}`)) {
                const t = fresh("r");
                out.push(`${pad}${typeEmit(outs[0].type)} ${t} = ${call};`);
                bind.set(node.id + `:out:${outs[0].id}`, t);
            } else {
                out.push(`${pad}${call};`);
            }
            emitExecOut(g, node, "then", out, ind, bind, seen);
            return;
        }

        // 未覆盖的 impure 节点:留痕(逃逸节点见下一轮)
        out.push(`${pad}// TODO 未生成:${def.label}`);
        emitExecOut(g, node, "then", out, ind, bind, seen);
    }

    // ── 单图 → 方法体 ───────────────────────────────────────
    function entryOf(g: BlueprintGraph): GraphNode | null {
        for (const n of g.nodes) {
            const sp = defForNode(n, g).special;
            if (sp === "event-root" || sp === "lifecycle" || sp === "fn-in") return n;
        }
        return null;
    }

    function eventGraphMethod(g: BlueprintGraph, entry: GraphNode): string {
        const def = defForNode(entry, g);
        const evSimple = entry.defType.startsWith("event:")
            ? entry.defType.slice(6)
            : (def.desc && /Event$/.test(def.desc) ? def.desc : simpleType(def.desc));
        const evFqn = typeEmit(evSimple);
        const method = "on" + (evSimple || "Event").replace(/Event$/, "");
        const body: string[] = [];
        emitExecOut(g, entry, "then", body, 2, new Map(), new Set());
        return [
            `    @org.bukkit.event.EventHandler`,
            `    public void ${method}(${evFqn} event) {`,
            ...body,
            `    }`,
        ].join("\n");
    }

    function lifecycleBody(g: BlueprintGraph, entry: GraphNode): string[] {
        const body: string[] = [];
        emitExecOut(g, entry, "then", body, 2, new Map(), new Set());
        return body;
    }

    function functionMethod(g: BlueprintGraph): string {
        const entry = g.nodes.find(n => defForNode(n, g).special === "fn-in") || null;
        const name = fnName.get(g.id) || ident(g.name, "fn");
        const params = (g.inputs || []).map(p => `${typeEmit(p.type)} ${ident(p.name)}`).join(", ");
        const retType = g.outputs?.length ? typeEmit(g.outputs[0].type) : "void";
        const body: string[] = [];
        if (entry) emitExecOut(g, entry, "then", body, 2, new Map(), new Set());
        if (retType !== "void" && !body.some(l => /\breturn\b/.test(l)))
            body.push(`        return ${defaultFor(g.outputs![0].type)};`);
        return [
            `    public ${retType} ${name}(${params}) {`,
            ...body,
            `    }`,
        ].join("\n");
    }

    // 单图预览:返回该图对应的方法源码
    function graphMethod(g: BlueprintGraph): string {
        if (g.graphType === "function") return functionMethod(g);
        const entry = entryOf(g);
        if (!entry) return `    // 「${g.name}」缺少入口(事件根 / 生命周期)`;
        const def = defForNode(entry, g);
        if (def.special === "lifecycle") {
            const kind = entry.defType === "life.onDisable" ? "onDisable" : "onEnable";
            return [`    @Override`, `    public void ${kind}() {`, ...lifecycleBody(g, entry), `    }`].join("\n");
        }
        return eventGraphMethod(g, entry);
    }

    // 整插件类
    function plugin(className = "GeneratedPlugin"): string {
        localCounter = 0;
        const events: string[] = [];
        const functions: string[] = [];
        const enableBody: string[] = [];
        const disableBody: string[] = [];
        let isListener = false;

        for (const g of doc.graphs) {
            if (g.graphType === "function") {
                if (g.nodes.length) functions.push(functionMethod(g));
                continue;
            }
            const entry = entryOf(g);
            if (!entry) continue;
            const def = defForNode(entry, g);
            if (def.special === "lifecycle") {
                const body = lifecycleBody(g, entry);
                if (entry.defType === "life.onDisable") disableBody.push(...body);
                else enableBody.push(...body);
            } else if (def.special === "event-root") {
                events.push(eventGraphMethod(g, entry));
                isListener = true;
            }
        }

        const fields = doc.variables.map(v =>
            `    private ${typeEmit(v.dataType)} ${ident(v.name)}` +
            (v.default != null && v.default !== "" ? ` = ${formatLiteral(v.default, v.dataType)}` : "") + ";");

        const onEnable: string[] = [];
        if (isListener || enableBody.length) {
            onEnable.push(`    @Override`, `    public void onEnable() {`);
            if (isListener) onEnable.push(`        org.bukkit.Bukkit.getPluginManager().registerEvents(this, this);`);
            onEnable.push(...enableBody, `    }`);
        }
        const onDisable: string[] = [];
        if (disableBody.length) onDisable.push(`    @Override`, `    public void onDisable() {`, ...disableBody, `    }`);

        const impl = isListener ? " implements org.bukkit.event.Listener" : "";
        const members = [
            fields.length ? fields.join("\n") : "",
            onEnable.join("\n"),
            onDisable.join("\n"),
            ...events,
            ...functions,
        ].filter(Boolean);

        return [
            `// 由蓝图确定性生成(bluemap §4)。真相源是图;此代码为产物,勿手改。`,
            `public class ${className} extends org.bukkit.plugin.java.JavaPlugin${impl} {`,
            ``,
            members.join("\n\n"),
            ``,
            `}`,
        ].join("\n");
    }

    return { plugin, graphMethod };
}

// ── 对外 API ────────────────────────────────────────────────
export function generatePlugin(doc: BlueprintDoc, className?: string): string {
    return createGen(doc).plugin(className);
}
export function generateGraphCode(graph: BlueprintGraph, doc: BlueprintDoc): string {
    return createGen(doc).graphMethod(graph);
}

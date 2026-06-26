// 代码 → 图:确定性 AST 解析(bluemap §4.1/§4.2),全程无 AI。
// 用 java-parser(chevrotain)拿 CST,把已知构造映射成节点;覆盖不到的降级为
// 逃逸节点(§4.3),承载原始代码片段并声明边界针脚,绝不失败、绝不丢逻辑。
//
// 设计目标:能把本系统 codegen 产出的 Java 解析回等价图(往返稳定),
// 其余 Java(AI 改过的)尽力映射、其余逃逸。

import { parse as parseJava } from "java-parser";
import { newId, simpleType } from "./model";
import { CURATED } from "./curated";
import { eventRootDefs } from "./registry";
import type { BlueprintGraph, GraphNode, GraphEdge, NodeDef, PinDef, Variable } from "./model";

// ── CST 导航小工具 ──────────────────────────────────────────
type Cst = any;
const kids = (n: Cst, k: string): Cst[] => (n?.children?.[k]) || [];
const kid = (n: Cst, k: string): Cst | undefined => kids(n, k)[0];
const img = (t: Cst): string => t?.image ?? "";

let SRC = "";
function sliceOf(n: Cst): string {
    const loc = n?.location;
    if (!loc || loc.startOffset == null) return "";
    return SRC.slice(loc.startOffset, loc.endOffset + 1);
}

// fqnOrRefType → 点分各段 ["player","sendMessage"]
function fqnParts(fqn: Cst): string[] {
    const out: string[] = [];
    const first = kid(fqn, "fqnOrRefTypePartFirst");
    if (first) out.push(img(kid(kid(first, "fqnOrRefTypePartCommon"), "Identifier")));
    for (const r of kids(fqn, "fqnOrRefTypePartRest"))
        out.push(img(kid(kid(r, "fqnOrRefTypePartCommon"), "Identifier")));
    return out.filter(Boolean);
}

const accessorFor = (id: string, type?: string) => {
    const cap = id.charAt(0).toUpperCase() + id.slice(1);
    const s = simpleType(type);
    return (s === "boolean" || s === "Boolean") ? "is" + cap : "get" + cap;
};

const BINOP: Record<string, string> = { "+": "value.concat", "&&": "value.and", "||": "value.or", ">": "value.greaterThan", "==": "value.equals" };

interface End { node: string; pin: string; }
interface StmtFlow { head: End | null; tails: End[]; } // head=入口 exec-in;tails=待接续的 exec-out 端点
const PASS: StmtFlow = { head: null, tails: [] };

// 事件根定义:先策展(按 desc 简单名),再 jar,最后兜底合成
function findEventRoot(simple: string): NodeDef {
    const cu = CURATED.find(d => d.special === "event-root" && d.desc === simple);
    if (cu) return cu;
    const jar = eventRootDefs().find(d => d.type === `event:${simple}`);
    if (jar) return jar;
    return { type: `event:${simple}`, category: "事件", label: simple, kind: "impure", special: "event-root", desc: simple, pins: [{ id: "then", name: "▷", direction: "out", pinKind: "exec" }] };
}

// ── 单方法 → 单图 的构造器 ──────────────────────────────────
function buildGraph(opts: {
    graphId: string; name: string; graphType: "event" | "function";
    inputs: { id: string; name: string; type: string }[];
    outputs: { id: string; name: string; type: string }[];
    bodyBlock: Cst | undefined;
    entry: "event" | "lifecycle" | "function";
    eventSimple?: string; eventParam?: string; lifecycleType?: string;
    fnMap: Map<string, { graphId: string; inputs: { id: string; type: string }[]; outputs: { id: string; type: string }[] }>;
    warnings: string[];
}): BlueprintGraph {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const symbols = new Map<string, End & { type: string }>(); // 局部变量 / 参数 名 → 产出端点

    function add(defType: string, inlineDef?: NodeDef, extra: Partial<GraphNode> = {}): GraphNode {
        const n: GraphNode = { id: newId(), defType, pos: { x: 0, y: 0 }, ...(inlineDef ? { inlineDef } : {}), ...extra };
        nodes.push(n);
        return n;
    }
    function link(a: End, b: End, kind: "exec" | "data") {
        edges.push({ id: newId(), from: a, to: b, pinKind: kind });
    }
    const chain = (n: GraphNode): StmtFlow => ({ head: { node: n.id, pin: "exec" }, tails: [{ node: n.id, pin: "then" }] });

    // 逃逸节点
    function escNode(raw: string, kind: "stmt" | "data"): GraphNode {
        const pins: PinDef[] = kind === "stmt"
            ? [{ id: "exec", name: "▷", direction: "in", pinKind: "exec" }, { id: "then", name: "▷", direction: "out", pinKind: "exec" }]
            : [{ id: "value", name: "值", direction: "out", pinKind: "data", dataType: "Object" }];
        const def: NodeDef = { type: "escape", category: "逃逸", label: "原始代码", kind: kind === "stmt" ? "impure" : "pure", special: "escape", pins, desc: raw.slice(0, 120) };
        return add("escape", def, { literals: { __raw: raw } });
    }
    function escapeStmt(n: Cst, why: string): StmtFlow { opts.warnings.push(why); return chain(escNode(sliceOf(n), "stmt")); }
    function escapeData(n: Cst, why?: string): End { if (why) opts.warnings.push(why); const e = escNode(sliceOf(n), "data"); return { node: e.id, pin: "value" }; }

    // ── 表达式 ──────────────────────────────────────────────
    function mapExpr(expr: Cst): End {
        const cond = kid(expr, "conditionalExpression");
        if (!cond) return escapeData(expr, "lambda/未知表达式");
        if (kid(cond, "QuestionMark") || kids(cond, "Colon").length) return escapeData(cond, "三元表达式");
        return mapBinary(kid(cond, "binaryExpression"));
    }
    function mapBinary(bin: Cst): End {
        if (!bin) return escapeData(bin);
        if (kid(bin, "Instanceof")) return escapeData(bin, "instanceof");
        const ops = kids(bin, "BinaryOperator").map(img);
        const operands = kids(bin, "unaryExpression");
        if (ops.length === 0) return mapUnary(operands[0]);
        const uniform = ops.every(o => o === ops[0]) && BINOP[ops[0]] && operands.length === ops.length + 1;
        if (!uniform) return escapeData(bin, "复合/未支持运算");
        let left = mapUnary(operands[0]);
        for (let i = 0; i < ops.length; i++) {
            const right = mapUnary(operands[i + 1]);
            const op = add(BINOP[ops[0]]);
            link(left, { node: op.id, pin: "a" }, "data");
            link(right, { node: op.id, pin: "b" }, "data");
            left = { node: op.id, pin: "result" };
        }
        return left;
    }
    function mapUnary(u: Cst): End {
        const prefixes = kids(u, "UnaryPrefixOperator").map(img);
        const primary = kid(u, "primary");
        if (prefixes.length === 1 && prefixes[0] === "!") {
            const inner = mapPrimary(primary);
            const n = add("value.not");
            link(inner, { node: n.id, pin: "in" }, "data");
            return { node: n.id, pin: "out" };
        }
        if (prefixes.length > 0) return escapeData(u, "前缀运算");
        return mapPrimary(primary);
    }
    function mapPrimary(primary: Cst): End {
        if (!primary) return escapeData(primary);
        const prefix = kid(primary, "primaryPrefix");
        const suffixes = kids(primary, "primarySuffix");
        if (suffixes.length === 0) {
            const paren = kid(prefix, "parenthesisExpression");
            if (paren) return mapExpr(kid(paren, "expression"));
            const lit = kid(prefix, "literal");
            if (lit) return mapLiteral(lit);
            const fqn = kid(prefix, "fqnOrRefType");
            if (fqn) {
                const parts = fqnParts(fqn);
                if (parts.length === 1) return resolveName(parts[0]);
                return escapeData(primary, "字段访问链");
            }
            return escapeData(primary, "cast/new/其它");
        }
        if (suffixes.length === 1) {
            const mis = kid(suffixes[0], "methodInvocationSuffix");
            const fqn = kid(prefix, "fqnOrRefType");
            if (mis && fqn) { const r = mapInvocation(fqn, mis, false); return r.value || escapeData(primary, "调用无返回值"); }
        }
        return escapeData(primary, "复杂主表达式");
    }
    function mapLiteral(lit: Cst): End {
        if (kid(lit, "StringLiteral")) {
            const raw = img(kid(lit, "StringLiteral"));
            const n = add("value.stringLiteral", undefined, { literals: { value: unquote(raw) } });
            return { node: n.id, pin: "value" };
        }
        const intl = kid(lit, "integerLiteral");
        if (intl) { const n = add("value.intLiteral", undefined, { literals: { value: sliceOf(intl) } }); return { node: n.id, pin: "value" }; }
        const fl = kid(lit, "floatingPointLiteral");
        if (fl) { const n = add("value.doubleLiteral", undefined, { literals: { value: sliceOf(fl).replace(/[dDfF]$/, "") } }); return { node: n.id, pin: "value" }; }
        const bl = kid(lit, "booleanLiteral") || kid(lit, "BooleanLiteral");
        if (bl) { const n = add("value.boolLiteral", undefined, { literals: { value: sliceOf(lit).trim() } }); return { node: n.id, pin: "value" }; }
        return escapeData(lit, "字面量(null/char 等)");
    }
    function resolveName(name: string): End {
        const sym = symbols.get(name);
        if (sym) return { node: sym.node, pin: sym.pin };
        // 字段 / 未知名 → var:get(变量不存在时类型回落 Object)
        const n = add("var:get", undefined, { varRef: { name, mode: "get" } });
        return { node: n.id, pin: "value" };
    }

    // 方法调用 → 节点。node=供 exec 接续(仅当 exec=true);value=数据出端;exec=该 node 是否在执行链上
    function mapInvocation(fqn: Cst, mis: Cst, statement: boolean): { node?: GraphNode; value?: End; exec?: boolean } {
        const parts = fqnParts(fqn);
        const method = parts[parts.length - 1];
        const recv = parts.slice(0, -1);
        const args = kids(kid(mis, "argumentList"), "expression").map(mapExpr);
        const lastRecv = recv[recv.length - 1] || "";

        // 事件 getter:event.getX()(纯引用,无新节点)
        if (recv.length === 1 && recv[0] === opts.eventParam && eventNode && eventDef) {
            const pin = eventDef.pins.find(p => p.direction === "out" && p.pinKind === "data"
                && (p.accessor || accessorFor(p.id, p.dataType)) === method);
            if (pin) return { value: { node: eventNode.id, pin: pin.id } };
        }
        // 全局动作 / 便利
        if (lastRecv === "Objects" && method === "equals" && args.length === 2) {
            const n = add("value.equals"); link(args[0], { node: n.id, pin: "a" }, "data"); link(args[1], { node: n.id, pin: "b" }, "data");
            return { value: { node: n.id, pin: "result" } };
        }
        if (lastRecv === "Bukkit") {
            if (method === "getOnlinePlayers") { const n = add("value.onlinePlayers"); return { node: n, value: { node: n.id, pin: "players" }, exec: false }; }
            if (method === "broadcastMessage" && statement) { const n = add("action.broadcast"); if (args[0]) link(args[0], { node: n.id, pin: "message" }, "data"); return { node: n, exec: true }; }
            if (method === "dispatchCommand" && statement) { const n = add("action.runCommand"); const cmd = args[args.length - 1]; if (cmd) link(cmd, { node: n.id, pin: "command" }, "data"); return { node: n, exec: true }; }
        }
        // 无接收者:函数调用(图引用)
        if (recv.length === 0) {
            const f = opts.fnMap.get(method);
            if (f) {
                const n = add(`graphref:${f.graphId}`, undefined, { graphRef: f.graphId });
                f.inputs.forEach((inp, i) => { if (args[i]) link(args[i], { node: n.id, pin: `in:${inp.id}` }, "data"); });
                return { node: n, value: f.outputs[0] ? { node: n.id, pin: `out:${f.outputs[0].id}` } : undefined, exec: true };
            }
        }
        // 实例方法调用:接收者是已知值
        if (recv.length === 1 && symbols.has(recv[0])) {
            const sym = symbols.get(recv[0])!;
            const mn = memberNode(method, { node: sym.node, pin: sym.pin }, sym.type, args, statement);
            return { node: mn, value: { node: mn.id, pin: "ret" }, exec: statement };
        }
        // 其余(静态/链式/未知)→ 逃逸
        return {};
    }
    // 合成实例成员节点(self + 参数 + ret;statement 时带 exec)
    function memberNode(method: string, recvEnd: End, recvType: string, args: End[], statement: boolean): GraphNode {
        const t = simpleType(recvType) || "Object";
        const pins: PinDef[] = [];
        if (statement) pins.push({ id: "exec", name: "▷", direction: "in", pinKind: "exec" });
        pins.push({ id: "self", name: t, direction: "in", pinKind: "data", dataType: t });
        args.forEach((_, i) => pins.push({ id: "p" + i, name: "arg" + i, direction: "in", pinKind: "data", dataType: "Object" }));
        if (statement) pins.push({ id: "then", name: "▷", direction: "out", pinKind: "exec" });
        pins.push({ id: "ret", name: "返回", direction: "out", pinKind: "data", dataType: "Object" });
        const def: NodeDef = { type: `member:${t}#${method}(${args.map(() => "Object").join(",")})`, category: t, label: `${t}.${method}`, kind: statement ? "impure" : "pure", special: "member", pins, desc: `${t}.${method}` };
        const n = add(def.type, def);
        link(recvEnd, { node: n.id, pin: "self" }, "data");
        args.forEach((a, i) => link(a, { node: n.id, pin: "p" + i }, "data"));
        return n;
    }

    // ── 语句 ────────────────────────────────────────────────
    function mapStatements(list: Cst[]): StmtFlow {
        let head: End | null = null, tails: End[] = [], started = false;
        for (const bs of list) {
            const m = mapBlockStatement(bs);
            if (!m.head) continue; // 纯局部声明:无 exec 贡献
            if (!started) { head = m.head; started = true; }
            else for (const t of tails) link(t, m.head, "exec");
            tails = m.tails;
        }
        return { head, tails };
    }
    function mapBlockStatement(bs: Cst): StmtFlow {
        const lvds = kid(bs, "localVariableDeclarationStatement");
        if (lvds) return mapLocalVar(kid(lvds, "localVariableDeclaration"));
        const st = kid(bs, "statement");
        if (st) return mapStatement(st);
        return PASS;
    }
    // 局部变量声明:RHS 是方法调用 → 作为语句入执行链并绑定 name→ret;否则纯值别名
    function mapLocalVar(lvd: Cst): StmtFlow {
        const decl = kid(kid(lvd, "variableDeclaratorList"), "variableDeclarator");
        const name = img(kid(kid(decl, "variableDeclaratorId"), "Identifier"));
        const type = simpleType(sliceOf(kid(lvd, "localVariableType")));
        const init = kid(decl, "variableInitializer");
        if (!init || !name) return PASS;
        const expr = kid(init, "expression");
        const be = kid(kid(expr, "conditionalExpression"), "binaryExpression");
        if (be && kids(be, "BinaryOperator").length === 0 && !kid(be, "AssignmentOperator") && !kid(be, "Instanceof")) {
            const primary = kid(kids(be, "unaryExpression")[0], "primary");
            const suffixes = kids(primary, "primarySuffix");
            const fqn = kid(kid(primary, "primaryPrefix"), "fqnOrRefType");
            if (suffixes.length === 1 && fqn && kid(suffixes[0], "methodInvocationSuffix")) {
                const r = mapInvocation(fqn, kid(suffixes[0], "methodInvocationSuffix"), true);
                if (r.value) symbols.set(name, { node: r.value.node, pin: r.value.pin, type });
                if (r.node && r.exec) return chain(r.node);
                if (r.value) return PASS;
            }
        }
        const end = mapExpr(expr);
        symbols.set(name, { node: end.node, pin: end.pin, type });
        return PASS;
    }
    function mapStatement(st: Cst): StmtFlow {
        const ifs = kid(st, "ifStatement");
        if (ifs) return mapIf(ifs);
        const fors = kid(st, "forStatement");
        if (fors) { const ef = kid(fors, "enhancedForStatement"); return ef ? mapFor(ef) : escapeStmt(fors, "基础 for"); }
        const wo = kid(st, "statementWithoutTrailingSubstatement");
        if (wo) return mapWO(wo);
        return escapeStmt(st, "while/labeled 等语句");
    }
    function mapWO(wo: Cst): StmtFlow {
        const es = kid(wo, "expressionStatement");
        if (es) return mapExprStmt(es);
        const ret = kid(wo, "returnStatement");
        if (ret) return mapReturn(ret);
        const blk = kid(wo, "block");
        if (blk) { const bss = kid(blk, "blockStatements"); return bss ? mapStatements(kids(bss, "blockStatement")) : PASS; }
        return escapeStmt(wo, "switch/try/throw 等语句");
    }
    function mapExprStmt(es: Cst): StmtFlow {
        if (sliceOf(es).includes("registerEvents(")) return PASS; // 跳过 onEnable 的监听器注册样板
        const bin = kid(kid(kid(es, "statementExpression"), "expression"), "conditionalExpression");
        const be = kid(bin, "binaryExpression");
        if (!be) return escapeStmt(es, "表达式语句");
        if (kid(be, "AssignmentOperator")) return mapAssign(be);
        // 方法调用语句
        const operands = kids(be, "unaryExpression");
        if (kids(be, "BinaryOperator").length === 0 && operands.length === 1) {
            const primary = kid(operands[0], "primary");
            const suffixes = kids(primary, "primarySuffix");
            const fqn = kid(kid(primary, "primaryPrefix"), "fqnOrRefType");
            if (suffixes.length === 1 && fqn && kid(suffixes[0], "methodInvocationSuffix")) {
                const r = mapInvocation(fqn, kid(suffixes[0], "methodInvocationSuffix"), true);
                if (r.node && r.exec) return chain(r.node);
            }
        }
        return escapeStmt(es, "未识别的语句");
    }
    function mapAssign(be: Cst): StmtFlow {
        const lhs = kids(be, "unaryExpression")[0];
        const fqn = kid(kid(kid(lhs, "primary"), "primaryPrefix"), "fqnOrRefType");
        const name = fqn ? fqnParts(fqn)[0] : "";
        const rhs = kid(be, "expression");
        const valEnd = mapExpr(rhs);
        const n = add("var:set", undefined, { varRef: { name: name || "var", mode: "set" } });
        link(valEnd, { node: n.id, pin: "value" }, "data");
        if (name) symbols.set(name, { node: n.id, pin: "out", type: symbols.get(name)?.type || "Object" });
        return chain(n);
    }
    function mapReturn(ret: Cst): StmtFlow {
        const n = add("fn:out");
        const expr = kid(ret, "expression");
        const o = opts.outputs[0];
        if (expr && o) link(mapExpr(expr), { node: n.id, pin: `p:${o.id}` }, "data");
        return { head: { node: n.id, pin: "exec" }, tails: [] }; // 终止
    }
    function mapIf(ifs: Cst): StmtFlow {
        const cond = mapExpr(kid(ifs, "expression"));
        const branch = add("flow.branch");
        link(cond, { node: branch.id, pin: "condition" }, "data");
        const stmts = kids(ifs, "statement");
        const hasElse = !!kid(ifs, "Else");
        const thenM = stmts[0] ? mapStatement(stmts[0]) : PASS;
        let tails: End[] = [];
        if (thenM.head) { link({ node: branch.id, pin: "true" }, thenM.head, "exec"); tails.push(...thenM.tails); }
        else tails.push({ node: branch.id, pin: "true" });
        if (hasElse && stmts[1]) {
            const elseM = mapStatement(stmts[1]);
            if (elseM.head) { link({ node: branch.id, pin: "false" }, elseM.head, "exec"); tails.push(...elseM.tails); }
            else tails.push({ node: branch.id, pin: "false" });
        } else tails.push({ node: branch.id, pin: "false" });
        return { head: { node: branch.id, pin: "exec" }, tails };
    }
    function mapFor(ef: Cst): StmtFlow {
        const lvd = kid(ef, "localVariableDeclaration");
        const varName = img(kid(kid(kid(kid(lvd, "variableDeclaratorList"), "variableDeclarator"), "variableDeclaratorId"), "Identifier"));
        const varType = simpleType(sliceOf(kid(lvd, "localVariableType")));
        const iterable = kid(ef, "expression");
        const isOnline = sliceOf(iterable).includes("getOnlinePlayers");
        let loop: GraphNode;
        if (isOnline) {
            loop = add("flow.forEachPlayer");
            symbols.set(varName, { node: loop.id, pin: "player", type: "Player" });
        } else {
            loop = add("flow.forEach");
            link(mapExpr(iterable), { node: loop.id, pin: "list" }, "data");
            symbols.set(varName, { node: loop.id, pin: "item", type: varType || "Object" });
        }
        const body = kid(ef, "statement");
        const bm = body ? mapStatement(body) : PASS;
        if (bm.head) link({ node: loop.id, pin: "loop" }, bm.head, "exec");
        return { head: { node: loop.id, pin: "exec" }, tails: [{ node: loop.id, pin: "done" }] };
    }

    // ── 入口节点 + 主体 ─────────────────────────────────────
    let eventNode: GraphNode | undefined;
    let eventDef: NodeDef | undefined;
    let entryNode: GraphNode;
    if (opts.entry === "event") {
        eventDef = findEventRoot(opts.eventSimple || "Event");
        eventNode = add(eventDef.type, CURATED.includes(eventDef) ? undefined : eventDef);
        entryNode = eventNode;
    } else if (opts.entry === "lifecycle") {
        entryNode = add(opts.lifecycleType === "onDisable" ? "life.onDisable" : "life.onEnable");
    } else {
        entryNode = add("fn:in");
        for (const inp of opts.inputs) symbols.set(inp.name, { node: entryNode.id, pin: `p:${inp.id}`, type: inp.type });
    }

    const bss = opts.bodyBlock ? kid(opts.bodyBlock, "blockStatements") : undefined;
    const body = bss ? mapStatements(kids(bss, "blockStatement")) : PASS;
    const entryExec = opts.entry === "function" || opts.entry === "lifecycle" ? "then" : "then";
    if (body.head) link({ node: entryNode.id, pin: entryExec }, body.head, "exec");

    return {
        id: opts.graphId, name: opts.name, graphType: opts.graphType,
        nodes, edges,
        ...(opts.inputs.length ? { inputs: opts.inputs } : {}),
        ...(opts.outputs.length ? { outputs: opts.outputs } : {}),
    };
}

function unquote(s: string): string {
    if (s.length >= 2 && s[0] === '"') s = s.slice(1, -1);
    return s.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
}

// ── 顶层:整段 Java → 图集 + 变量 ───────────────────────────
export interface ParseResult { graphs: BlueprintGraph[]; variables: Variable[]; warnings: string[]; error?: string; }

export function parseJavaToDoc(code: string): ParseResult {
    SRC = code;
    const warnings: string[] = [];
    let cst: Cst;
    try { cst = parseJava(code); }
    catch (e: any) { return { graphs: [], variables: [], warnings: [], error: "Java 解析失败:" + (e?.message || e) }; }

    // 定位 classBody
    const ocu = kid(cst, "ordinaryCompilationUnit");
    const typeDecls = kids(ocu, "typeDeclaration");
    let classBody: Cst | undefined;
    for (const td of typeDecls) {
        const ncd = kid(kid(td, "classDeclaration"), "normalClassDeclaration");
        if (ncd) { classBody = kid(ncd, "classBody"); break; }
    }
    if (!classBody) return { graphs: [], variables: [], warnings: [], error: "未找到类定义" };

    // 字段 → 变量
    const variables: Variable[] = [];
    const methods: Cst[] = [];
    for (const cbd of kids(classBody, "classBodyDeclaration")) {
        const cmd = kid(cbd, "classMemberDeclaration");
        if (!cmd) continue;
        const fd = kid(cmd, "fieldDeclaration");
        if (fd) {
            const type = simpleType(sliceOf(kid(fd, "unannType")));
            for (const vd of kids(kid(fd, "variableDeclaratorList"), "variableDeclarator")) {
                const name = img(kid(kid(vd, "variableDeclaratorId"), "Identifier"));
                const init = kid(vd, "variableInitializer");
                if (name) variables.push({ name, dataType: type || "Object", scope: "field", ...(init ? { default: sliceOf(kid(init, "expression")) } : {}) });
            }
            continue;
        }
        const md = kid(cmd, "methodDeclaration");
        if (md) methods.push(md);
    }

    // pass1:为每个方法定身份 + 函数名表
    interface MethodInfo {
        md: Cst; name: string; graphId: string;
        entry: "event" | "lifecycle" | "function";
        eventSimple?: string; eventParam?: string; lifecycleType?: string;
        inputs: { id: string; name: string; type: string }[];
        outputs: { id: string; name: string; type: string }[];
        body: Cst | undefined;
    }
    const fnMap = new Map<string, { graphId: string; inputs: { id: string; type: string }[]; outputs: { id: string; type: string }[] }>();
    const infos: MethodInfo[] = [];
    for (const md of methods) {
        const header = kid(md, "methodHeader");
        const decl = kid(header, "methodDeclarator");
        const name = img(kid(decl, "Identifier"));
        const annos = kids(md, "methodModifier").map(m => sliceOf(kid(m, "annotation"))).filter(Boolean);
        const isEvent = annos.some(a => a.includes("EventHandler"));
        const params: { id: string; name: string; type: string }[] = [];
        for (const fp of kids(kid(decl, "formalParameterList"), "formalParameter")) {
            const reg = kid(fp, "variableParaRegularParameter");
            if (!reg) continue;
            const pType = simpleType(sliceOf(kid(reg, "unannType")));
            const pName = img(kid(kid(reg, "variableDeclaratorId"), "Identifier"));
            params.push({ id: newId(), name: pName, type: pType || "Object" });
        }
        const result = kid(header, "result");
        const retType = kid(result, "Void") ? "void" : simpleType(sliceOf(result));
        const body = kid(kid(md, "methodBody"), "block");
        const graphId = newId();

        let entry: MethodInfo["entry"] = "function";
        let eventSimple: string | undefined, eventParam: string | undefined, lifecycleType: string | undefined;
        if (isEvent && params.length) { entry = "event"; eventSimple = params[0].type; eventParam = params[0].name; }
        else if (name === "onEnable" || name === "onDisable") { entry = "lifecycle"; lifecycleType = name; }

        const outputs = (entry === "function" && retType && retType !== "void")
            ? [{ id: newId(), name: "返回", type: retType }] : [];
        const inputs = entry === "function" ? params : [];

        if (entry === "function") fnMap.set(name, { graphId, inputs: inputs.map(p => ({ id: p.id, type: p.type })), outputs: outputs.map(o => ({ id: o.id, type: o.type })) });
        infos.push({ md, name, graphId, entry, eventSimple, eventParam, lifecycleType, inputs, outputs, body });
    }

    // pass2:构造每个图
    const graphs: BlueprintGraph[] = [];
    for (const mi of infos) {
        const gName = mi.entry === "event" ? (mi.eventSimple || mi.name) : mi.name;
        const graphType: "event" | "function" = mi.entry === "function" ? "function" : "event";
        graphs.push(buildGraph({
            graphId: mi.graphId, name: gName, graphType,
            inputs: mi.inputs, outputs: mi.outputs, bodyBlock: mi.body,
            entry: mi.entry, eventSimple: mi.eventSimple, eventParam: mi.eventParam, lifecycleType: mi.lifecycleType,
            fnMap, warnings,
        }));
    }

    return { graphs, variables, warnings };
}

// 多文件(整个已生成项目)→ 合并图集。每个 .java 各自解析,变量按名去重。
export function parseFiles(files: { path: string; content: string }[]): ParseResult {
    const graphs: BlueprintGraph[] = [];
    const variables: Variable[] = [];
    const warnings: string[] = [];
    for (const f of files) {
        if (!/\.java$/i.test(f.path)) continue;
        const r = parseJavaToDoc(f.content);
        if (r.error) { warnings.push(`${f.path}:${r.error}`); continue; }
        const base = f.path.split("/").pop()?.replace(/\.java$/i, "") || "";
        for (const g of r.graphs) {
            // 给图名带上来源类名前缀,避免多文件同名(onEnable 等)混淆
            graphs.push(base && !g.name.startsWith(base) ? { ...g, name: `${base}·${g.name}` } : g);
        }
        for (const v of r.variables) if (!variables.some(x => x.name === v.name)) variables.push(v);
        warnings.push(...r.warnings);
    }
    return { graphs, variables, warnings };
}

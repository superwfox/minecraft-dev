// 蓝图语义图 IR —— 真相源(bluemap §2)。本期建模,暂不投影到 Java。
// 三层:可视化图 / 语义 IR(本文件) / Java 代码(后续期)。

export type PinKind = "exec" | "data";
export type PinDir = "in" | "out";
export type NodeKind = "pure" | "impure";
// 节点语义分类(bluemap §3.5):事件根 / 控制流 / 变量 / cast / 生命周期 / 动作 / 字面量
export type NodeSpecial =
    | "event-root"
    | "control-flow"
    | "variable"
    | "cast"
    | "lifecycle"
    | "action"
    | "literal"
    | "member"
    | "function"
    | "fn-in"
    | "fn-out"
    | "escape"; // 码→图:节点词汇表覆盖不了的原始代码(bluemap §4.3)

export interface PinDef {
    id: string;
    name: string;
    direction: PinDir;
    pinKind: PinKind;
    dataType?: string; // data 针脚带类型(简单名或 FQN);exec 无类型
    accessor?: string; // 事件根 data-out 的取值方法名(codegen 用),如 getClickedBlock;缺省按 get/is+首字母大写推断
}

export interface NodeDef {
    type: string;       // 注册表内唯一类型 id
    category: string;   // 左侧面板分组
    label: string;
    kind: NodeKind;     // pure(仅 data) / impure(带 exec)
    special?: NodeSpecial;
    pins: PinDef[];
    desc?: string;
    // codegen 模板留空位 —— 下一期(IR→Java)填
}

export interface NodePos { x: number; y: number; }

// 画布上的节点实例
export interface GraphNode {
    id: string;        // 创建期稳定 id(本期 randomUUID;指纹身份随码→图落地再上)
    defType: string;   // 指向 NodeDef.type;变量节点用 "var:get"/"var:set"
    pos: NodePos;
    literals?: Record<string, string>; // pinId → 字面量(未连接的 data-in)
    varRef?: { name: string; mode: "get" | "set" };
    graphRef?: string; // 函数引用节点:指向某张图(折叠为单节点)
    // member/变量节点把定义快照内联,保证 jar 未加载/重载后仍能渲染
    inlineDef?: NodeDef;
    title?: string;
    fp?: string; // 稳定指纹(bluemap §2.2):由结构/内容派生,跨重解析保持,用于布局保全与 diff
}

export interface EndPoint { node: string; pin: string; }

export interface GraphEdge {
    id: string;
    from: EndPoint; // 输出针脚
    to: EndPoint;   // 输入针脚
    pinKind: PinKind;
}

export type VarScope = "local" | "field" | "persistent";
export interface Variable {
    name: string;
    dataType: string;
    scope: VarScope;
    default?: string;
}

export type GraphType = "event" | "function";
// 函数图的参数 / 返回项(由 fn-in / fn-out 节点声明,决定函数引用节点的针脚)
export interface GraphParam { id: string; name: string; type: string; }
export interface BlueprintGraph {
    id: string;
    name: string;
    graphType: GraphType;
    nodes: GraphNode[];
    edges: GraphEdge[];
    inputs?: GraphParam[];
    outputs?: GraphParam[];
    fp?: string; // 图身份(入口:事件类型/生命周期/函数名),用于重解析时把新图对到旧图
}

export interface Viewport { scale: number; panX: number; panY: number; }

// 持久化单元(bluemap §2.5,必含位置)
export interface BlueprintDoc {
    taskId: string;
    graphs: BlueprintGraph[];
    variables: Variable[];
    viewport?: Viewport;
}

export function newId(): string {
    try {
        return crypto.randomUUID();
    } catch {
        return "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
}

// 去掉泛型与包名,取简单类型名;数组保留 []
export function simpleType(t?: string): string {
    if (!t) return "";
    let s = t.trim();
    const lt = s.indexOf("<");
    if (lt >= 0) s = s.slice(0, lt); // 抹掉泛型实参
    const arr = (s.match(/\[\]/g) || []).length;
    s = s.replace(/\[\]/g, "");
    const dot = s.lastIndexOf(".");
    if (dot >= 0) s = s.slice(dot + 1);
    return s + "[]".repeat(arr);
}

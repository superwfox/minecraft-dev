import { createInitialTree, emptyNodeContract, publicTreeView, type NodeContract, type TreeNode } from "./functions/_lib/projectTree";

// Local fixtures share the production behavior-path and file-binding protocol.
export interface PathPreviewNode { id: string; title: string; kind: string; summary: string; fileIds: string[] }
export interface PathPreview { id: string; title: string; nodes: PathPreviewNode[]; testStatus?: "pending" | "passed" | "failed" }
const tree = createInitialTree("Paper", "1.21.4");
tree.project = { projectName: "HomePlus", packageName: "com.tahai.homeplus", javaVersion: "21", summary: "通过不同交互进入共用的选地、框选与领地保存逻辑。", externalDeps: [] };
tree.revision = 13; tree.status = "ready";
tree.modules.unshift({ id: "selection", title: "选地与框选", responsibility: "交互入口、选地会话、区域校验与保存", kind: "business" });
function add(id: string, kind: TreeNode["kind"], title: string, responsibility: string, depends: string[], contract: Partial<NodeContract>, moduleId = "selection") {
  tree.nodes.push({ id, kind, title, responsibility, depends, contract: { ...emptyNodeContract(), ...contract }, moduleId, tag: null, pairId: "", origin: "planner" });
}
add("SelectionToolListener", "ListenerGen", "选地工具交互", "识别木锄与地面右击事件，读取点击位置并开启玩家的选地会话。", ["SelectionSessionManager"], { constructors: [{ params: "SelectionSessionManager sessions" }], events: ["PlayerInteractEvent"] });
add("GroundSelectionListener", "ListenerGen", "地面交互入口", "识别潜行、空手与地面右击条件，调用共用服务开启选地会话。", ["SelectionSessionManager"], { constructors: [{ params: "SelectionSessionManager sessions" }], events: ["PlayerInteractEvent"] });
add("ClaimCommand", "CommandGen", "选地命令", "处理 /claim select，建立等待首次点击的会话并提示玩家操作。", ["SelectionSessionManager"], { constructors: [{ params: "SelectionSessionManager sessions" }], commands: [{ name: "claim", aliases: [], permission: "homeplus.claim", usage: "/claim select", description: "进入领地框选" }] });
add("SelectionSessionManager", "ManagerGen", "共用选地会话", "按玩家保存选择状态；所有入口复用同一个会话管理文件，避免重复实现。", [], { methods: [{ name: "begin", params: "Player player, Location firstCorner", returns: "void", isStatic: false }, { name: "setCorner", params: "Player player, Location corner", returns: "boolean", isStatic: false }], lifecycle: "onEnable" });
add("RegionSelectionListener", "ListenerGen", "共用两点框选", "读取已有会话，将地面点击转为角点，两个角点齐全时提交区域校验与保存。", ["SelectionSessionManager", "RegionValidator", "ClaimRepository"], { constructors: [{ params: "SelectionSessionManager sessions, RegionValidator validator, ClaimRepository repository" }], events: ["PlayerInteractEvent"] });
add("RegionValidator", "UtilGen", "区域校验", "校验两个角点的世界、面积与重叠情况；失败时给出原因并保留会话。", [], { methods: [{ name: "validate", params: "Location first, Location second", returns: "boolean", isStatic: false }] });
add("ClaimRepository", "ManagerGen", "领地数据保存", "按玩家保存通过校验的区域，完成后清理选地会话。", [], { methods: [{ name: "save", params: "UUID owner, Location first, Location second", returns: "void", isStatic: false }], lifecycle: "onDisable" });
add("config.yml", "ConfigGen", "选地配置", "提供选地工具、面积限制与提示文案。", [], {}, "_resources");
tree.nodes.find(node => node.id === "Main")!.depends = ["SelectionToolListener", "GroundSelectionListener", "ClaimCommand", "SelectionSessionManager", "RegionSelectionListener"];
export const previewTree = publicTreeView(tree);
export const rootStep: PathPreviewNode = { id: "entry", title: "Main", kind: "插件入口", summary: "初始化选地服务，注册交互入口与共用的框选逻辑。", fileIds: ["Main", "plugin.yml", "config.yml"] };
const finish = (prefix: string): PathPreviewNode => ({ id: prefix + "-save", title: "校验区域，保存领地", kind: "完成", summary: "检查世界、面积与重叠，通过后保存并结束会话。", fileIds: ["RegionValidator", "ClaimRepository"] });
export const previewPaths: PathPreview[] = [
  { id: "tool", title: "工具选地", nodes: [
    { id: "tool-start", title: "手持木锄，右击地面", kind: "触发", summary: "识别选地工具，以点击位置作为第一个角点。", fileIds: ["SelectionToolListener", "SelectionSessionManager"] },
    { id: "tool-select", title: "再次点击，确定第二点", kind: "框选", summary: "读取当前会话，将下一次地面点击设为第二角点。", fileIds: ["RegionSelectionListener", "SelectionSessionManager"] },
    finish("tool"),
  ] },
  { id: "ground", title: "地面交互选地", nodes: [
    { id: "ground-start", title: "潜行空手，右击地面", kind: "触发", summary: "满足交互条件后进入选地，记录第一个角点。", fileIds: ["GroundSelectionListener", "SelectionSessionManager"] },
    { id: "ground-select", title: "点击另一处，框选区域", kind: "框选", summary: "复用两点选择逻辑，补齐区域的第二个角点。", fileIds: ["RegionSelectionListener", "SelectionSessionManager"] },
    finish("ground"),
  ] },
  { id: "command", title: "命令选地", nodes: [
    { id: "command-start", title: "输入 /claim select", kind: "触发", summary: "建立待选会话，提示玩家点击地面的两个角点。", fileIds: ["ClaimCommand", "SelectionSessionManager"] },
    { id: "command-select", title: "依次点击区域的两个角", kind: "框选", summary: "第一次点击记录起点，第二次点击完成范围。", fileIds: ["RegionSelectionListener", "SelectionSessionManager"] },
    finish("command"),
  ] },
];

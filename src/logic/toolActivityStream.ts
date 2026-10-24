import { beginToolActivity, type ToolActivityHandle } from "./toolActivity";

const treeTools: Record<string, string> = {
    set_project: "更新项目信息", upsert_module: "调整业务模块", upsert_node: "更新节点与文件绑定",
    remove_items: "移除节点", merge_nodes: "合并共享逻辑", finish_tree: "提交结构校验",
};

/** Presentation follows committed SSE outcomes, never token output or a timer. */
export function createToolActivityStream(signal: AbortSignal, parent?: ToolActivityHandle) {
    let tree = parent, skill: ToolActivityHandle | undefined;
    const calls = new Set<string>();
    let results: { ok: boolean; summary: string; error?: string }[] | undefined;
    return {
        event(event: any) {
            if (event.type === "skill_context") {
                if (event.status === "started") {
                    skill?.finish("cancelled", "上下文装载已替换");
                    skill = beginToolActivity({ kind: "skill", title: "装载 Skill 上下文", detail: "读取所选 Skill 的能力说明", context: `${event.requested || 0} 个 Skill`, signal });
                } else if (event.status === "completed") {
                    const loaded = Number(event.loaded) || 0;
                    skill?.finish(loaded === event.requested ? "success" : "notice", `已装载 ${loaded}/${event.requested || 0} 个 Skill`);
                    skill = undefined;
                }
            }
            if (event.type === "tool_call" && treeTools[event.name]) {
                calls.add(`${event.index}:${event.name}`);
                tree ??= beginToolActivity({ kind: "tree", title: "修改结构树", signal });
                tree.update(treeTools[event.name], `${calls.size} 项工具调用`);
            }
            if (event.type === "tree_ops") results = Array.isArray(event.results) ? event.results : [];
        },
        finish() {
            skill?.finish("notice", "未收到上下文装载确认");
            if (!tree) return;
            const failures = results?.filter(result => !result.ok) || [];
            if (failures.length) tree.finish("error", failures[0].error || failures[0].summary || "部分结构操作未完成");
            else if (!parent) tree.finish(results?.length ? "success" : "notice", results?.length
                ? `已应用 ${results.length} 项结构操作` : "本轮未确认结构变更");
        },
        fail(error: unknown) {
            skill?.fail(error);
            if (!parent) tree?.fail(error);
        },
    };
}

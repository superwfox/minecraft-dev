import { beforeEach, expect, it, vi } from "vitest";
import { createInitialTree, nodePath } from "../../functions/_lib/projectTree";
const memory = vi.hoisted(() => ({ raw: "" }));
vi.mock("../../functions/_lib/taskStore", () => ({ getOwnedTask: vi.fn(async (_env: unknown, _taskId: string, uid: string) => uid === "owner" ? memory.raw : null) }));
import { onRequestGet } from "../../functions/api/generate/source";
beforeEach(() => { const tree = createInitialTree("Paper", "1.21.4"); tree.status = "locked"; tree.project.projectName = "Home"; tree.project.packageName = "com.tahai.home"; memory.raw = JSON.stringify({ tree, generatedFiles: tree.nodes.map(node => ({ path: nodePath(tree, node), content: node.id === "plugin.yml" ? "name: Home\nmain: com.tahai.home.Main\n" : "content" })) }); });
const invoke = (query = "", uid = "owner") => onRequestGet({ request: new Request("https://app.test/api/generate/source?taskId=task" + query), env: { TASKS: {} }, data: { uid } } as unknown as Parameters<typeof onRequestGet>[0]);
it("returns all files with an idempotent plugin watermark", async () => { const result = await (await invoke()).json() as { files: { content: string }[] }; expect(result.files).toHaveLength(3); expect(result.files[1].content).toContain("TAHAI"); });
it("requires a locked complete tree for the archive", async () => {
    const state = JSON.parse(memory.raw); state.tree.status = "ready"; memory.raw = JSON.stringify(state); expect((await invoke()).status).toBe(409);
    state.tree.status = "locked"; state.generatedFiles.pop(); memory.raw = JSON.stringify(state); expect((await invoke()).status).toBe(409);
});
it("loads individual generated files and rejects missing or unplanned paths", async () => { expect((await invoke("&path=pom.xml")).status).toBe(200); expect((await invoke("&path=../secret")).status).toBe(404); const state = JSON.parse(memory.raw); state.generatedFiles = []; memory.raw = JSON.stringify(state); expect((await invoke("&path=pom.xml")).status).toBe(404); });
it("hides other owners' tasks", async () => { expect((await invoke("", "other")).status).toBe(404); });

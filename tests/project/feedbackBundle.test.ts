import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { feedbackBundle } from "../../shared/feedbackBundle";
import { sourceZip } from "../../shared/projectZip";

describe("automatic public feedback ZIPs", () => {
    it("redacts before ZIP creation and preserves binary resources, metadata and stable retry bytes", async () => {
        const files = [
            { path: "project.json", content: JSON.stringify({ projectName: "Example" }) },
            { path: "manifest.json", content: JSON.stringify({ journalIncomplete: true, missing: ["execution-journal"] }) },
            { path: "source/Main.java", content: "// private-server-token\nclass Main {}" },
            { path: "source/PROJECT_TREE.md", content: "# Example" },
            { path: "resources.json", content: JSON.stringify([{ path: "src/main/resources/icon.png", content: "AAECAw==", encoding: "base64" }, { path: "config.yml", content: btoa("key: private-server-token"), encoding: "base64" }]) },
            { path: "events.json", content: "[]" },
            { path: "images/one.png", encoding: "base64" as const, content: "iVBORw0KGgo=" },
        ];
        const first = await feedbackBundle(files, ["private-server-token"]), second = await feedbackBundle(files, ["private-server-token"]);
        expect(first.files.map(file => file.path)).toEqual(["source.zip", "diagnostics.zip", "images/one.png"]);
        expect(first.files).toEqual(second.files); expect(first.missing).toContain("execution-journal");
        const source = await JSZip.loadAsync(first.files[0].content, { base64: true });
        expect(await source.file("Example/Main.java")!.async("string")).toContain("[REDACTED]");
        expect(await source.file("Example/config.yml")!.async("string")).toContain("[REDACTED]");
        expect(await source.file("Example/PROJECT_TREE.md")!.async("string")).toBe("# Example");
        expect(Array.from(await source.file("Example/src/main/resources/icon.png")!.async("uint8array"))).toEqual([0, 1, 2, 3]);
        const diagnostics = await JSZip.loadAsync(first.files[1].content, { base64: true });
        expect(JSON.parse(await diagnostics.file("resources.json")!.async("string"))[1].content).not.toContain(btoa("key: private-server-token"));
    });
    it("uses the same source packer as downloading and describes missing source honestly", async () => {
        const bytes = await sourceZip({ projectName: "Empty", files: [], treeMarkdown: "# 已规划，尚未生成" }), zip = await JSZip.loadAsync(bytes);
        expect(await zip.file("Empty/README.txt")!.async("string")).toContain("尚未生成源码");
        expect(await zip.file("Empty/PROJECT_TREE.md")!.async("string")).toContain("已规划");
        await expect(sourceZip({ projectName: "Bad", files: [{ path: "../outside", content: "x" }] })).rejects.toThrow("路径");
    });
});

import { describe, expect, it } from "vitest";
import { extractFileSummary } from "../../functions/_lib/fileSummary";

describe("extractFileSummary", () => {
    it("extracts the public Java API needed by later file prompts", () => {
        const summary = extractFileSummary("src/main/java/dev/test/EconomyManager.java", `
package dev.test;

public final class EconomyManager implements Listener, AutoCloseable {
    public static final String DEFAULT_CURRENCY = "coins";

    public EconomyManager(Plugin plugin, ConfigManager config) {}

    public double getBalance(UUID playerId) {
        return 0;
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {}

    private void save() {
        getConfig().getDouble("starting-balance");
        getCommand("balance");
    }
}
`, "Manages player balances");

        expect(summary).toMatchObject({
            className: "EconomyManager",
            implements: ["Listener", "AutoCloseable"],
            constructors: [{ params: "Plugin plugin, ConfigManager config" }],
            publicFields: ["static final String DEFAULT_CURRENCY"],
            description: "Manages player balances",
        });
        expect(summary.publicMethods).toEqual([
            { returns: "double", name: "getBalance", params: "UUID playerId" },
            { returns: "void", name: "onJoin", params: "PlayerJoinEvent event" },
        ]);
        expect(summary.events).toContain("PlayerJoinEvent");
        expect(summary.commands).toEqual(["balance"]);
        expect(summary.configKeys).toEqual(["starting-balance"]);
    });

    it("records an implicit constructor only for a public Java class", () => {
        expect(extractFileSummary("src/Main.java", `
public class Main {
    public void start() {}
}
`, "Plugin entry point").constructors).toEqual([{ params: "" }]);

        expect(extractFileSummary("src/Internal.java", `
class Internal {
    public void run() {}
}
`, "Internal helper").constructors).toEqual([]);
    });

    it("keeps non-Java summaries descriptive without inventing Java APIs", () => {
        expect(extractFileSummary("plugin.yml", "name: Example", "Plugin metadata")).toEqual({
            description: "Plugin metadata",
        });
    });
});

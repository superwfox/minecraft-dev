    it("lets Planner learn only classified external integrations on the selected path", () => {
        const ordinaryBukkit = makeNeed({ id: "ordinary-bukkit" });
        const nms = makeNeed({
            id: "nms",
            integrationKind: "nms",
            triggerReason: "nms_version_sensitive",
            claim: {
                subject: "net.minecraft.server.level.ServerPlayer#connection",
                question: "What is the exact NMS connection member for Paper 1.21.4?",
            },
            scope: {
                packageName: "net.minecraft.server.level",
                symbol: "net.minecraft.server.level.ServerPlayer#connection",
            },
        });
        const craftBukkit = makeNeed({
            id: "craftbukkit",
            integrationKind: "craftbukkit",
            triggerReason: "reflection_contract",
            claim: {
                subject: "org.bukkit.craftbukkit.entity.CraftPlayer#getHandle",
                question: "What is the CraftBukkit getHandle contract for Paper 1.21.4?",
            },
            scope: {
                packageName: "org.bukkit.craftbukkit.entity",
                symbol: "org.bukkit.craftbukkit.entity.CraftPlayer#getHandle",
            },
        });
        const reflection = makeNeed({
            id: "reflection",
            integrationKind: "version_reflection",
            triggerReason: "reflection_contract",
            claim: {
                subject: "Class.forName org.bukkit.craftbukkit.CraftServer reflection",
                question: "Which reflected CraftBukkit server class is valid for Paper 1.21.4?",
            },
            scope: {
                packageName: "org.bukkit.craftbukkit",
                symbol: "Class.forName(org.bukkit.craftbukkit.CraftServer)",
            },
        });
        const placeholderApi = makeNeed({
            id: "placeholder-api",
            integrationKind: "external_plugin",
            triggerReason: "external_plugin_contract",
            pathIds: ["path-a"],
            claim: {
                subject: "PlaceholderAPI#setPlaceholders",
                question: "What is the supported PlaceholderAPI placeholder expansion call?",
            },
            scope: {
                dependency: "PlaceholderAPI",
                packageName: "me.clip.placeholderapi",
                symbol: "me.clip.placeholderapi.PlaceholderAPI#setPlaceholders",
            },
        });

        const accepted = filterPlannerKnowledgeNeeds([
            ordinaryBukkit,
            nms,
            craftBukkit,
            reflection,
            placeholderApi,
        ], {
            userPrompt: "使用 PlaceholderAPI 解析玩家变量",
            externalDeps: ["PlaceholderAPI"],
            chosenPathId: "path-a",
        });

        expect(accepted.accepted.map((need) => need.id)).toEqual([
            "nms",
            "craftbukkit",
            "reflection",
            "placeholder-api",
        ]);
        expect(accepted.rejected).toEqual([{
            index: 0,
            reason: "missing_integration_classification",
        }]);
        expect(filterPlannerKnowledgeNeeds([placeholderApi], {
            userPrompt: "使用 PlaceholderAPI 解析玩家变量",
            externalDeps: ["PlaceholderAPI"],
            chosenPathId: "path-b",
        }).rejected).toEqual([{ index: 0, reason: "unselected_path" }]);
        expect(filterPlannerKnowledgeNeeds([placeholderApi], {
            userPrompt: "普通计分板",
            externalDeps: ["PlaceholderAPI"],
            chosenPathId: "path-a",
        }).rejected).toEqual([{ index: 0, reason: "external_plugin_not_declared" }]);
    });

    it("requires a matching selected path for path-scoped needs", () => {
        const globalNeed = makeNeed({ id: "global" });
        const pathNeed = makeNeed({ id: "path-only", pathIds: ["path-a"] });

        expect(filterSelectedPathKnowledgeNeeds([globalNeed, pathNeed])).toEqual({
            accepted: [globalNeed],
            rejected: [{ index: 1, reason: "path_not_selected" }],
        });
        expect(filterSelectedPathKnowledgeNeeds([globalNeed, pathNeed], "path-b")).toEqual({
            accepted: [globalNeed],
            rejected: [{ index: 1, reason: "unselected_path" }],
        });
        expect(filterSelectedPathKnowledgeNeeds([globalNeed, pathNeed], "path-a").accepted)
            .toEqual([globalNeed, pathNeed]);
    });

import {describe, expect, it} from "vitest";
import {
    fileGenPrompt,
    plannerClarifyPrompt,
    plannerPrompt,
} from "../../functions/_lib/prompts";

describe("simple requirement prompt defaults", () => {
    it("does not turn a join reward into clarification work", () => {
        const prompt = plannerClarifyPrompt(
            "玩家进入服务器时发放 1 颗钻石",
            "PAPER",
            "26.2",
            [],
        );

        expect(prompt.system).toContain("没有必要问题时直接完成澄清");
        expect(prompt.system).toContain("如果没有则直接返回 done:true");
        expect(prompt.system).toContain("实现模型可以安全决定的技术细节必须自动补偿");
        expect(prompt.system).toContain("每次实际加入都触发");
        expect(prompt.system).toContain("进入服务器时发放物品”不属于登录阶段歧义");
        expect(prompt.system).toContain("背包容量、空返回值等纯技术边界");
    });

    it("carries lightweight defaults and inventory safety into planning and generation", () => {
        const plan = plannerPrompt(
            "玩家进入服务器时发放 1 颗钻石",
            "PAPER",
            "26.2",
        );
        const file = fileGenPrompt(
            "src/main/java/com/tahai/joinreward/JoinListener.java",
            "玩家加入后发放 1 颗钻石",
            {
                projectName: "JoinReward",
                packageName: "com.tahai.joinreward",
                coreType: "PAPER",
                version: "26.2",
                javaVersion: "25",
            },
            [],
        );

        expect(plan.system).toContain("未要求反馈就不额外发消息");
        expect(plan.system).toContain("未要求首次奖励或防刷就不增加持久化记录");
        expect(plan.system).toContain("Inventory.addItem 返回的剩余物");
        expect(file.system).toContain("无法放入的部分使用玩家世界的 dropItemNaturally");
        expect(file.system).toContain("不得自行扩展为邮件或暂存系统");
    });
});

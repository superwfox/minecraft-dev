import { defineConfig } from "vitepress"

export default defineConfig({
    title: "踏海",
    description: "MC DevTool 项目文档",

    themeConfig: {
        nav: [
            { text: "首页", link: "/" },
            { text: "使用方法", link: "/usage" },
            { text: "前端实现", link: "/frontend" },
            { text: "步骤生成", link: "/step-generation" },
            {
                text: "JAR 生成",
                items: [
                    { text: "总体流程", link: "/jar/overview" },
                    { text: "AI 能力运用", link: "/jar/ai-usage" },
                    { text: "部署要点", link: "/jar/deployment" },
                ],
            },
            { text: "设计决策", link: "/decisions" },
        ],
        sidebar: [
            {
                text: "文档",
                items: [
                    { text: "使用方法", link: "/usage" },
                    { text: "前端实现", link: "/frontend" },
                    { text: "步骤生成", link: "/step-generation" },
                ],
            },
            {
                text: "JAR 生成",
                items: [
                    { text: "总体流程", link: "/jar/overview" },
                    { text: "AI 能力运用", link: "/jar/ai-usage" },
                    { text: "部署要点", link: "/jar/deployment" },
                ],
            },
            {
                text: "其他",
                items: [
                    { text: "设计决策", link: "/decisions" },
                ],
            },
        ],
        socialLinks: [
            { icon: "github", link: "https://github.com/superwfox/minecraft-dev" },
        ],
        search: {
            provider: "local",
        },
    },
})

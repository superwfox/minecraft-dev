import { defineConfig } from "vitepress"
import { withMermaid } from "vitepress-plugin-mermaid"

export default withMermaid(defineConfig({
    title: "踏海",
    description: "MC DevTool 项目文档",

    themeConfig: {
        nav: [
            { text: "首页", link: "/" },
            {
                text: "入门指南",
                items: [
                    { text: "项目介绍", link: "/guide/introduction" },
                    { text: "快速开始", link: "/guide/quick-start" },
                    { text: "完整演示", link: "/guide/demo-showcase" },
                ],
            },
            {
                text: "核心功能",
                items: [
                    { text: "AI 工作流", link: "/features/ai-workflow" },
                    { text: "浏览器 IDE", link: "/features/ide" },
                    { text: "可视化蓝图", link: "/features/blueprint" },
                    { text: "技能库", link: "/features/skills" },
                    { text: "前端亮点", link: "/features/frontend-highlights" },
                ],
            },
            {
                text: "技术文档",
                items: [
                    { text: "系统架构", link: "/technical/architecture" },
                    { text: "API 参考", link: "/technical/api-reference" },
                    { text: "开发部署", link: "/technical/development" },
                ],
            },
        ],
        sidebar: [
            {
                text: "入门指南",
                items: [
                    { text: "项目介绍", link: "/guide/introduction" },
                    { text: "快速开始", link: "/guide/quick-start" },
                    { text: "完整演示", link: "/guide/demo-showcase" },
                ],
            },
            {
                text: "核心功能",
                items: [
                    { text: "AI 工作流", link: "/features/ai-workflow" },
                    { text: "浏览器 IDE", link: "/features/ide" },
                    { text: "可视化蓝图", link: "/features/blueprint" },
                    { text: "技能库", link: "/features/skills" },
                    { text: "前端亮点", link: "/features/frontend-highlights" },
                ],
            },
            {
                text: "技术文档",
                items: [
                    { text: "系统架构", link: "/technical/architecture" },
                    { text: "API 参考", link: "/technical/api-reference" },
                    { text: "开发部署", link: "/technical/development" },
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
}))

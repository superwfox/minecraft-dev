import { defineConfig } from "vitepress"
import { withMermaid } from "vitepress-plugin-mermaid"

const guide = [
    { text: "项目介绍", link: "/guide/introduction" },
    { text: "快速开始", link: "/guide/quick-start" },
    { text: "对话框", link: "/guide/chatbox" },
    { text: "生成示例", link: "/guide/demo-showcase" },
    { text: "常见问题", link: "/guide/faq" },
]

const features = [
    { text: "结构树与行为路径", link: "/features/structure-tree" },
    { text: "生成、检查与编译", link: "/features/generation" },
    { text: "技能库", link: "/features/skills" },
    { text: "工程历史", link: "/features/project-history" },
    { text: "导入 JAR", link: "/features/jar-import" },
    { text: "问题反馈", link: "/features/feedback" },
]

const technical = [
    { text: "系统架构", link: "/technical/architecture" },
    { text: "生成流水线", link: "/technical/generation-pipeline" },
    { text: "编译诊断与 API 学习", link: "/technical/compile-learning" },
    { text: "工程生命周期", link: "/technical/project-lifecycle" },
    { text: "API 参考", link: "/technical/api-reference" },
    { text: "开发与部署", link: "/technical/development" },
    { text: "历史与停用功能", link: "/technical/history" },
]

export default withMermaid(defineConfig({
    title: "踏海",
    description: "MC DevTool 项目文档",
    head: [
        ["link", { rel: "icon", type: "image/png", href: "/icon.png" }],
    ],

    themeConfig: {
        logo: "/icon.png",
        nav: [
            { text: "首页", link: "/" },
            { text: "使用指南", items: guide },
            { text: "功能", items: features },
            { text: "技术细节", items: technical },
        ],
        sidebar: [
            { text: "使用指南", items: guide },
            { text: "功能", items: features },
            { text: "技术细节", collapsed: true, items: technical },
        ],
        socialLinks: [
            { icon: "github", link: "https://github.com/superwfox/minecraft-dev" },
        ],
        search: {
            provider: "local",
        },
        outline: { label: "本页目录" },
        docFooter: { prev: "上一页", next: "下一页" },
    },
}))

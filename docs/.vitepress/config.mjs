import {defineConfig} from "vitepress"

export default defineConfig({
    title: "踏海",
    description: "MC DevTool 项目文档",

    themeConfig: {
        nav: [
            {text: "首页", link: "/"},
            {text: "技术架构", link: "/architecture"},
            {text: "API 设计", link: "/api-design"},
            {text: "使用方法", link: "/usage"},
        ],
        sidebar: [
            {
                text: "文档",
                items: [
                    {text: "技术架构", link: "/architecture"},
                    {text: "API 设计", link: "/api-design"},
                    {text: "使用方法", link: "/usage"},
                ],
            },
        ],
        socialLinks: [
            {icon: "github", link: "https://github.com/superwfox/minecraft-dev"},
        ],
        search: {
            provider: "local",
        },
    },
})

import {defineConfig} from "vitepress"

export default defineConfig({
    title: "踏海",
    description: "VitePress site",

    themeConfig: {
        socialLinks: [
            {icon: 'github', link: 'https://github.com/superwfox/minecraft-dev'}
        ],
        search: {
            provider: 'local'
        }
    }
})

import {fileURLToPath, URL} from 'node:url'
import {defineConfig, loadEnv} from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

export default defineConfig(({mode}) => {
    const env = loadEnv(mode, process.cwd())
    const apiKey = env.VITE_DEEPSEEK_API_KEY || ""

    return {
        plugins: [vue(), vueDevTools()],
        resolve: {
            alias: {'@': fileURLToPath(new URL('./src', import.meta.url))},
        },
        server: {
            proxy: {
                // 本地开发：/api/chat 和 /api/stream 代理到 DeepSeek
                '/api/chat': {
                    target: 'https://api.deepseek.com',
                    changeOrigin: true,
                    rewrite: () => '/v1/chat/completions',
                    configure: (proxy) => {
                        proxy.on('proxyReq', (proxyReq) => {
                            proxyReq.setHeader('Authorization', 'Bearer ' + apiKey)
                        })
                    },
                },
                '/api/stream': {
                    target: 'https://api.deepseek.com',
                    changeOrigin: true,
                    rewrite: () => '/v1/chat/completions',
                    headers: {'Accept-Encoding': 'identity'},
                    configure: (proxy) => {
                        proxy.on('proxyReq', (proxyReq) => {
                            proxyReq.setHeader('Authorization', 'Bearer ' + apiKey)
                            proxyReq.setHeader('Accept-Encoding', 'identity')
                        })
                        proxy.on('proxyRes', (proxyRes) => {
                            delete proxyRes.headers['content-encoding']
                            delete proxyRes.headers['content-length']
                        })
                    },
                },
            },
        },
    }
})

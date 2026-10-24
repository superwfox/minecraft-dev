import {createApp} from 'vue'
import App from './App.vue'
import router from './router'
import {lattice} from './ui/lattice'
import './styles/lattice.css'
import './styles/typography.css'

createApp(App).directive('lattice', lattice).use(router).mount('#app')

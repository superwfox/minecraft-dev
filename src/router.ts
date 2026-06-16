import {createRouter, createWebHistory} from "vue-router";

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {path: "/", component: () => import("./pages/HomePage.vue")},
        {path: "/chat", component: () => import("./pages/ChatPage.vue")},
        {path: "/skills", component: () => import("./pages/SkillsPage.vue")},
        {path: "/ide/:taskId?", component: () => import("./ide/pages/IDEPage.vue")},
        {path: "/admin", component: () => import("./pages/AdminPage.vue")},
    ],
});

export default router;

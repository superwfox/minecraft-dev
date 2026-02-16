import {createRouter, createWebHistory} from "vue-router";

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {path: "/", component: () => import("./pages/HomePage.vue")},
        {path: "/chat", component: () => import("./pages/ChatPage.vue")},
    ],
});

export default router;

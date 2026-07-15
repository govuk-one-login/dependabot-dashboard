import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.scss";
import "diff2html/bundles/css/diff2html.min.css";

// Import routes
import DependabotPreflight from "./views/DependabotPreflight.vue";
import DependabotIssues from "./views/DependabotIssues.vue";

const routes = [
  {
    path: "/",
    name: "DependabotPreflight",
    component: DependabotPreflight,
  },
  {
    path: "/dependabot-preflight",
    redirect: "/",
  },
  {
    path: "/dependabot-issues",
    name: "DependabotIssues",
    component: DependabotIssues,
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

const app = createApp(App);
app.use(router);
app.mount("#app");

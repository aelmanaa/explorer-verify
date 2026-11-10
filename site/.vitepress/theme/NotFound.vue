<!--
  The 404 page of the docs site (#307, audit finding F20). It replaces VitePress's default through
  the theme's `not-found` slot, which both the built 404.html and a missing page reached in the
  browser render. It links the overview, every page of the "Get started" sidebar group, which holds
  the quickstarts, and the search box. It reads the links from the sidebar, so a new quickstart
  appears here without a change to this file.
-->
<script setup>
import { useData, withBase } from "vitepress";
import { computed } from "vue";

const { theme } = useData();

function links(items) {
  return items.flatMap((item) => [
    ...(item.link === undefined ? [] : [{ text: item.text, link: item.link }]),
    ...links(item.items ?? []),
  ]);
}

const start = computed(() => {
  const sidebar = Array.isArray(theme.value.sidebar) ? theme.value.sidebar : [];
  const group = sidebar.find((item) => item.text === "Get started");
  return group === undefined ? [] : links(group.items ?? []);
});

// The search box opens on Ctrl+K or Cmd+K; VitePress listens for the key on the window.
function openSearch() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, metaKey: true }));
}
</script>

<template>
  <div class="ev-not-found">
    <p class="code">404</p>
    <h1 class="title">Page not found</h1>
    <p>
      No page of the explorer-verify docs has this address. It may have moved, or the link may be
      wrong.
    </p>
    <p>
      <button type="button" class="search" @click="openSearch">Search the docs</button>
    </p>
    <h2 v-if="start.length > 0">Get started</h2>
    <ul v-if="start.length > 0">
      <li v-for="item in start" :key="item.link">
        <a :href="withBase(item.link)">{{ item.text }}</a>
      </li>
    </ul>
    <p>Agents: <a :href="withBase('/llms.txt')">llms.txt</a> lists every page as Markdown.</p>
  </div>
</template>

<style scoped>
.ev-not-found {
  max-width: 640px;
  margin: 0 auto;
  padding: 64px 24px 96px;
  line-height: 1.6;
}
.code {
  font-size: 64px;
  font-weight: 600;
  line-height: 1;
  color: var(--vp-c-text-2);
}
.title {
  margin: 16px 0;
  font-size: 24px;
  font-weight: 600;
}
h2 {
  margin: 32px 0 8px;
  font-size: 18px;
  font-weight: 600;
}
ul {
  padding-left: 20px;
  list-style: disc;
}
a {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}
.search {
  margin-top: 16px;
  padding: 6px 16px;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 20px;
  color: var(--vp-c-brand-1);
  font-weight: 500;
}
.search:hover {
  background-color: var(--vp-c-brand-soft);
}
</style>

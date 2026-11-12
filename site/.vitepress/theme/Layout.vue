<!--
  The layout of the docs site: VitePress's default layout with NotFound.vue in its `not-found`
  slot, and the CSS overrides of style.css (#307).
-->
<script setup>
import DefaultTheme from "vitepress/theme-without-fonts";

import NotFound from "./NotFound.vue";
</script>

<template>
  <DefaultTheme.Layout>
    <template #not-found>
      <NotFound />
    </template>
  </DefaultTheme.Layout>
</template>

<style src="./style.css"></style>

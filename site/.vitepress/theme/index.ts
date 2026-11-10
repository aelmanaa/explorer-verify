// The theme of the docs site (#307): VitePress's default theme with the layout in Layout.vue,
// which adds the 404 page of NotFound.vue and the CSS overrides of style.css.
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";

import Layout from "./Layout.vue";

const theme: Theme = { extends: DefaultTheme, Layout };

export default theme;

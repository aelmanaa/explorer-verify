// The theme of the docs site (#307): VitePress's default theme with the layout in Layout.vue,
// which adds the 404 page of NotFound.vue and the CSS overrides of style.css. It is the theme
// without VitePress's bundled Inter font: the site uses the system fonts of its logo (#373).
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";

import Layout from "./Layout.vue";

const theme: Theme = { extends: DefaultTheme, Layout };

export default theme;

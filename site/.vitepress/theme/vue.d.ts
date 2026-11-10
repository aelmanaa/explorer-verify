// The type of a single-file component that the theme imports. VitePress compiles `.vue` files;
// TypeScript only needs to know that each is a component a theme can use.
declare module "*.vue" {
  import type { Theme } from "vitepress";

  const component: NonNullable<Theme["Layout"]>;
  export default component;
}

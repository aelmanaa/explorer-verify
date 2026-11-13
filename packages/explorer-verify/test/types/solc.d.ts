// The part of solc-js (the `solc` npm package, which ships no types) that the tests use.
declare module "solc" {
  /** The solc-js wrapper around one compiler build. */
  interface Solc {
    /** Compiles a Standard JSON input, given as text, and returns the Standard JSON output as text. */
    compile(input: string): string;
    /** The full version of the bundled compiler, such as `0.8.24+commit.e11b9ed9.Emscripten.clang`. */
    version(): string;
  }
  const solc: Solc;
  export default solc;
}

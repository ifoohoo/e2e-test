// No-op shim for optional dependencies. Used by esbuild to replace
// source-map-support in the typescript bundle so the output is fully
// self-contained without requiring the package at runtime.
export function install() {}
export default { install };

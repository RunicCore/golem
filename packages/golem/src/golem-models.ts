// A script file on purpose: with a top-level import or export, `declare module` would augment a module instead of declaring one.
declare module '#golem-models' {
  export const layer: import('./serde.js').GolemLayer;
}

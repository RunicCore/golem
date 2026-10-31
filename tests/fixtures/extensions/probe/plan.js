// A third-party block that declares no job and registers one extension, `mark` (see mark.mjs). Core reads `extensions:` from the block itself.
exports.plan = {
  declare() {
    return [];
  },
};

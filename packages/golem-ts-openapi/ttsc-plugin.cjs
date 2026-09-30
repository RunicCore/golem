/**
 * ttsc plugin descriptor. Registers nestModelCodec metadata on @Body()/@Query()
 * parameters and rewrites serde generics. The Go source is the shared codegen
 * plugin, so this entry and @exprtlabs/golem/ttsc-plugin are one native backend.
 */
const path = require('node:path');
const { createRequire } = require('node:module');

module.exports = function createNestIObjectPlugin() {
  const requireFromHere = createRequire(__filename);
  const pluginFile = requireFromHere.resolve('@exprtlabs/golem/ttsc-plugin');
  return {
    name: '@exprtlabs/golem-ts-openapi/ttsc-plugin',
    source: path.join(path.dirname(pluginFile), 'plugin'),
    stage: 'transform',
  };
};

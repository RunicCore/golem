/**
 * ttsc plugin descriptor. Rewrites stringify<T>/parse<T>/validate<T>
 * calls to the generated codec registered for that named IObject/IModel.
 * The same native source stamps Nest body codec metadata when the project
 * also enables @exprtlabs/ts-to-openapi/ttsc-plugin, or sets "nest": true.
 */
const path = require('node:path');

module.exports = function createIObjectSerdePlugin(context) {
  return {
    name: '@exprtlabs/codegen/ttsc-plugin',
    source: path.resolve(context.dirname, 'plugin'),
    composes: ['@exprtlabs/ts-to-openapi/ttsc-plugin'],
    stage: 'transform',
  };
};

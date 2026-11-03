/** Declared data fields that shadow built-in Object.prototype members are unsupported. */
function isObjectPrototypeCollisionField(name: string): boolean {
  switch (name) {
    case '__defineGetter__':
    case '__defineSetter__':
    case '__lookupGetter__':
    case '__lookupSetter__':
    case '__proto__':
    case 'constructor':
    case 'hasOwnProperty':
    case 'isPrototypeOf':
    case 'propertyIsEnumerable':
    case 'toLocaleString':
    case 'toString':
    case 'valueOf':
      return true;
    default:
      return false;
  }
}

export function assertSupportedModelFieldName(name: string): void {
  if (isObjectPrototypeCollisionField(name)) {
    throw new TypeError(
      `Declared model field ${JSON.stringify(name)} conflicts with a built-in Object.prototype member; rename the field before generation.`,
    );
  }
}

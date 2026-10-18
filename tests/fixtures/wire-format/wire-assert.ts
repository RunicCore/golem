export type Same<Left, Right> = (<Probe>() => Probe extends Left ? 1 : 2) extends (<Probe>() => Probe extends Right ? 1 : 2) ? true : false;
export type NotAny<Value> = 0 extends 1 & Value ? false : true;
export type Assert<Value extends true> = Value;
export type MutuallyAssignable<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

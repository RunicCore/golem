import { TLedgerBaseModel } from './ledger.model.generated.js';

export type TLedger = { id: string };
export class Ledger extends TLedgerBaseModel {}
export class AdminLedger extends TLedgerBaseModel {}
export class RushLedger extends AdminLedger {}

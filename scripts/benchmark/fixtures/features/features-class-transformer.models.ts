import { Transform, Type } from 'class-transformer';
import 'reflect-metadata';

// #region checkout
export class LineItem {
  sku!: string;
  quantity!: number;
  price!: number;
}

export class SdkMoney {
  amount!: number;
  currency!: string;
}

export class CheckoutItem {
  sku!: string;
}

export class CheckoutBag {
  lane!: string;
}

export class CheckoutChannelOpen {
  kind!: 'open';
}

export class CheckoutChannelHold {
  kind!: 'hold';
  @Type(() => Date)
  until!: Date;
}

export class Checkout {
  @Type(() => SdkMoney)
  money!: SdkMoney;

  note!: string;

  @Transform(({ value }) => (typeof value === 'string' ? Number.parseInt(value, 16) : value), { toClassOnly: true })
  @Transform(({ value }) => (typeof value === 'number' ? value.toString(16) : value), { toPlainOnly: true })
  code!: number;

  @Type(() => Date)
  when!: Date;

  @Type(() => CheckoutItem)
  items!: CheckoutItem[];

  @Type(() => LineItem)
  primary!: LineItem;

  flags!: Record<string, string>;

  @Type(() => Object, {
    discriminator: {
      property: 'kind',
      subTypes: [
        { name: 'open', value: CheckoutChannelOpen },
        { name: 'hold', value: CheckoutChannelHold },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  channel!: CheckoutChannelOpen | CheckoutChannelHold;

  @Type(() => Date)
  span!: [Date, Date];
  @Type(() => Date)
  hold!: Date | null;

  @Type(() => CheckoutBag)
  bag?: CheckoutBag;

  memo?: string;
}
// #endregion checkout

// #region checkout-plain
// Dates stay date-time strings, and nothing converts.
export class PlainLineItem {
  sku!: string;
  quantity!: number;
  price!: number;
}

export class PlainMoney {
  amount!: number;
  currency!: string;
}

export class PlainItem {
  sku!: string;
}

export class PlainBag {
  lane!: string;
}

export class PlainChannelOpen {
  kind!: 'open';
}

export class PlainChannelHold {
  kind!: 'hold';
  until!: string;
}

export class CheckoutPlain {
  @Type(() => PlainMoney)
  money!: PlainMoney;

  note!: string;
  code!: string;
  when!: string;

  @Type(() => PlainItem)
  items!: PlainItem[];

  @Type(() => PlainLineItem)
  primary!: PlainLineItem;

  flags!: Record<string, string>;

  @Type(() => Object, {
    discriminator: {
      property: 'kind',
      subTypes: [
        { name: 'open', value: PlainChannelOpen },
        { name: 'hold', value: PlainChannelHold },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  channel!: PlainChannelOpen | PlainChannelHold;

  span!: [string, string];
  hold!: string | null;

  @Type(() => PlainBag)
  bag?: PlainBag;

  memo?: string;
}
// #endregion checkout-plain

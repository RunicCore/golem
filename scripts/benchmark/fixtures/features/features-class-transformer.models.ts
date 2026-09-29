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

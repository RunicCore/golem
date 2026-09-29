import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MinLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import 'reflect-metadata';

// #region checkout
export class LineItem {
  @IsString()
  @MinLength(3)
  sku!: string;

  @IsInt()
  @Min(0)
  quantity!: number;

  @Min(0)
  price!: number;
}

@ValidatorConstraint({ name: 'notReservedCurrency', async: false })
class NotReservedCurrencyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && value !== 'XXX' && /^[A-Z]{3}$/.test(value);
  }

  defaultMessage(_arguments: ValidationArguments): string {
    return 'Currency XXX is reserved.';
  }
}

@ValidatorConstraint({ name: 'notBlank', async: false })
class NotBlankConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && value.trim().length > 0;
  }

  defaultMessage(_arguments: ValidationArguments): string {
    return 'blank';
  }
}

export class SdkMoney {
  @IsInt()
  @Min(0)
  amount!: number;

  @IsString()
  @Validate(NotReservedCurrencyConstraint)
  currency!: string;
}

export class CheckoutItem {
  @IsString()
  @MinLength(3)
  sku!: string;
}

export class CheckoutBag {
  @IsString()
  lane!: string;
}

export class CheckoutChannelOpen {
  @IsString()
  kind!: 'open';
}

export class CheckoutChannelHold {
  @IsString()
  kind!: 'hold';

  @Type(() => Date)
  @IsDate()
  until!: Date;
}

export class Checkout {
  @ValidateNested()
  @Type(() => SdkMoney)
  money!: SdkMoney;

  @IsString()
  @Validate(NotBlankConstraint)
  note!: string;

  @Transform(({ value }) => (typeof value === 'string' ? Number.parseInt(value, 16) : value), { toClassOnly: true })
  @Transform(({ value }) => (typeof value === 'number' ? value.toString(16) : value), { toPlainOnly: true })
  @IsInt()
  @Min(1)
  code!: number;

  @Type(() => Date)
  @IsDate()
  when!: Date;

  @ValidateNested({ each: true })
  @Type(() => CheckoutItem)
  items!: CheckoutItem[];

  @ValidateNested()
  @Type(() => LineItem)
  primary!: LineItem;

  @IsObject()
  flags!: Record<string, string>;

  @ValidateNested()
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

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @Type(() => Date)
  @IsDate({ each: true })
  span!: [Date, Date];

  @ValidateIf((_, value) => value !== null)
  @Type(() => Date)
  @IsDate()
  hold!: Date | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CheckoutBag)
  bag?: CheckoutBag;

  @IsOptional()
  @IsString()
  memo?: string;
}
// #endregion checkout

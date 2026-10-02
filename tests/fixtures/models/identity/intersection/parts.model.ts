import type { IModel } from '@exprtlabs/golem/model';
import type { Maximum, Minimum, MinLength, Pattern } from '@exprtlabs/golem/tags';

export type TIdentified = IModel<{ id: string & MinLength<1> & Pattern<'^[a-z]+$'>; kind: 'person' | 'robot' }>;
export type TNamed = IModel<{ name: string; aliases: string[] }>;
export type TTimed = IModel<{ createdAt: number & Minimum<0> & Maximum<4102444800> }>;

type Geo = { lat: number; lng: number };
type Label = { label: string };
type Scale = { scale: 1 | 2 | 4 };

export type TPlace = IModel<{
  where: Geo & Label;
  spot: (Geo & Scale & { shape: 'point' }) | (Label & Scale & { shape: 'name' });
  size: number & Minimum<0> & Maximum<100> & Minimum<1>;
  tagged: ('a' | 'b') & { note: string };
}>;
export type TAll = IModel<TIdentified & TNamed & TTimed>;

import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import { createAjvFixtures } from './ajv.js';
import { createClassTransformerFixtures } from './class-transformer.js';
import { createClassValidatorFixtures } from './class-validator.js';
import { createGolemFixtures } from './golem.js';
import { createGolemObjectFixtures } from './golem-object.js';
import { createTypiaFixtures } from './typia.js';
import { createZodFixtures } from './zod.js';

export async function createComparisonFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  switch (adapter) {
    case 'golem':
    case 'golem-validated':
      return createGolemFixtures(adapter);
    case 'golem-object':
    case 'golem-object-off':
      return createGolemObjectFixtures(adapter);
    case 'class-transformer':
      return createClassTransformerFixtures(adapter);
    case 'class-validator':
      return createClassValidatorFixtures(adapter);
    case 'typia':
      return createTypiaFixtures(adapter);
    case 'zod':
      return createZodFixtures(adapter);
    case 'ajv':
      return createAjvFixtures(adapter);
  }
}

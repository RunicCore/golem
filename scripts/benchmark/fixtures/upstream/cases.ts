import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import { createClassTransformerFixtures } from './class-transformer.js';
import { createClassValidatorFixtures } from './class-validator.js';
import { createCodegenFixtures } from './codegen.js';
import { createCodegenObjectFixtures } from './codegen-object.js';
import { createTypiaFixtures } from './typia.js';
import { createZodFixtures } from './zod.js';

export async function createComparisonFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  switch (adapter) {
    case 'codegen':
    case 'codegen-runtime':
    case 'codegen-standalone':
      return createCodegenFixtures(adapter);
    case 'codegen-object':
      return createCodegenObjectFixtures(adapter);
    case 'class-transformer':
      return createClassTransformerFixtures(adapter);
    case 'class-validator':
      return createClassValidatorFixtures(adapter);
    case 'typia':
      return createTypiaFixtures(adapter);
    case 'zod':
      return createZodFixtures(adapter);
  }
}

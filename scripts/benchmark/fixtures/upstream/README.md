# Upstream structure fixtures

These fixtures adapt the structure definitions used by Typia's benchmark suite
to the comparison harness in this repository. The source is pinned to Typia
commit `0e4aeeec65d81d8024ad5bd7fb382a6f104aac75` and is licensed under the MIT
license; the attribution and license text are in [`LICENSE-MIT.txt`](./LICENSE-MIT.txt).

The adapted upstream paths are:

- `benchmark/src/structures/pure/ObjectSimple.ts`
- `benchmark/src/structures/pure/ObjectHierarchical.ts`
- `benchmark/src/structures/pure/ArrayHierarchical.ts`
- `benchmark/src/structures/class-validator/ClassValidatorObjectSimple.ts`
- `benchmark/src/structures/class-validator/ClassValidatorObjectHierarchical.ts`
- `benchmark/src/structures/class-validator/ClassValidatorArrayHierarchical.ts`

The random generators and spoiler lists from the original benchmark are not
part of this adapter. The harness uses fixed clock values and fixed numbers so
that every adapter receives the same complete payload. The array structure is
wrapped as `{ data: [company] }`; `ArrayHierarchical-1000` contains one company
with ten departments and one hundred employees per department.

The adapters preserve the upstream field shapes, including nullable object
unions and the four-element IP tuple. Invalid verification inputs are cloned
and mutated as `unknown`; no `any`-typed validation spoilers are copied from
upstream. `ObjectHierarchical-Constrained` keeps the same nested payload but
adds equivalent integer, range, string, pattern, and array-size constraints to
the Golem, class-validator, Typia and Zod declarations. The other fixtures are
structural and intentionally contain no validation tags. The unconstrained
`ObjectHierarchical` declarations remain only as base classes for the
constrained class-transformer and class-validator models.

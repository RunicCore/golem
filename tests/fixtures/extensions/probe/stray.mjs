// A test extension that fills a hook that no job offers.
export const extension = { hooks: { 'nobody.offers': () => 'never called' } };

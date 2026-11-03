// Has a rewrite and fills a hook that no job of the test project offers.
export const extension = {
  rewrite: () => ({ edits: [], reads: [], diagnostics: [] }),
  hooks: { 'nobody.offers': () => 'unused' },
};

// A test extension that fills the hook `hooked.note` of the package @fixture/hooked: the line is `<options.prefix><text>`. With `options.explode` the participant throws.
import { NOTE_HOOK } from '@fixture/hooked/plan';

export const extension = {
  hooks: {
    [NOTE_HOOK]: ({ text, options }) => {
      if (options.explode) throw new Error('note participant exploded');
      return `${options.prefix}${text}`;
    },
  },
};

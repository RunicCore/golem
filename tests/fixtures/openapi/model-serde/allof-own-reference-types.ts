import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { based: { name: 'Miso' } });
const at: Date | undefined = visit.based.at;

void at;

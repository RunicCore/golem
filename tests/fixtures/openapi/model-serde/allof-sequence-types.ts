import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, {
  memberWins: ['2024-05-06T07:08:09.000Z'],
  membersCarry: ['2024-05-07T08:09:10.000Z'],
  describedMember: ['2024-05-08T09:10:11.000Z'],
  bareArrayMember: ['2024-05-09T10:11:12.000Z'],
});
const memberWins: string[] = visit.memberWins;
const membersCarry: Date[] = visit.membersCarry;
const describedMember: Date[] = visit.describedMember;
const bareArrayMember: Date[] = visit.bareArrayMember;

void memberWins; void membersCarry; void describedMember; void bareArrayMember;

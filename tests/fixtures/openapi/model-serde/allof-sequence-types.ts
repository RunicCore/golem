import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, {
  restatingMember: ['2024-05-06T07:08:09.000Z'],
  restatedByMember: ['2024-05-07T08:09:10.000Z'],
  membersCarry: ['2024-05-08T09:10:11.000Z'],
  describedMember: ['2024-05-09T10:11:12.000Z'],
  bareArrayMember: ['2024-05-10T11:12:13.000Z'],
  convertingMemberWins: ['2024-05-11T12:13:14.000Z'],
});
const restatingMember: Date[] = visit.restatingMember;
const restatedByMember: Date[] = visit.restatedByMember;
const membersCarry: Date[] = visit.membersCarry;
const describedMember: Date[] = visit.describedMember;
const bareArrayMember: Date[] = visit.bareArrayMember;
const convertingMemberWins: Date[] = visit.convertingMemberWins;

void restatingMember; void restatedByMember; void membersCarry;
void describedMember; void bareArrayMember; void convertingMemberWins;

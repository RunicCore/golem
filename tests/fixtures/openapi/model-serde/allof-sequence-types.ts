import type { Visit } from './types.js';

declare const visit: Visit;
const restatingMember: Date[] = visit.restatingMember;
const restatedByMember: Date[] = visit.restatedByMember;
const membersCarry: Date[] = visit.membersCarry;
const describedMember: Date[] = visit.describedMember;
const bareArrayMember: Date[] = visit.bareArrayMember;
const convertingMemberWins: Date[] = visit.convertingMemberWins;

void restatingMember; void restatedByMember; void membersCarry;
void describedMember; void bareArrayMember; void convertingMemberWins;

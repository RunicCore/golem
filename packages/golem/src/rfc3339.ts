// RFC 3339 dates and times. The `date` and `time` formats of the validators and the converters of `Date` and Temporal read them,
// so a text one accepts is a text the other accepts. The module holds nothing else, so a model runtime loads no other format.

const TIME = /^([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:[Zz]|([+-])([0-9]{2}):([0-9]{2}))$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** True when `day` exists in `month` of `year`; `month` is 1 to 12. */
function isCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = month === 2 ? (isLeapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= days;
}

/** True when the clock fields are in range; `offset` is the UTC offset in minutes. Second 60 is a leap second, accepted only at 23:59:60 UTC. */
function isClockTime(hour: number, minute: number, second: number, offset: number): boolean {
  if (hour > 23 || minute > 59 || second > 60) return false;
  if (second < 60) return true;
  return (((hour * 60 + minute - offset) % 1440) + 1440) % 1440 === 23 * 60 + 59;
}

export function isDate(text: string): boolean {
  const match = DATE.exec(text);
  return match !== null && isCalendarDay(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** RFC 3339 full-time. */
export function isTime(text: string): boolean {
  const match = TIME.exec(text);
  if (!match) return false;
  let offset = 0;
  if (match[4] !== undefined) {
    const offsetHour = Number(match[5]);
    const offsetMinute = Number(match[6]);
    if (offsetHour > 23 || offsetMinute > 59) return false;
    offset = (match[4] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }
  return isClockTime(Number(match[1]), Number(match[2]), Number(match[3]), offset);
}

/** The value of the two ASCII digits of `text` at `index`, or -1 when one of them is not a digit. */
function twoDigitsAt(text: string, index: number): number {
  const tens = text.charCodeAt(index) - 48;
  const ones = text.charCodeAt(index + 1) - 48;
  return tens >= 0 && tens <= 9 && ones >= 0 && ones <= 9 ? tens * 10 + ones : -1;
}

/**
 * RFC 3339 date-time: `isDate`, a `T` or `t`, then `isTime`. It reads the characters in place, because a generated fast
 * check calls it once per date-time value and a regular expression with captures dominated that call.
 */
export function isDateTime(text: string): boolean {
  const separator = text.charCodeAt(10);
  if (text.length < 20 || (separator !== 84 && separator !== 116)) return false;
  if (text.charCodeAt(4) !== 45 || text.charCodeAt(7) !== 45 || text.charCodeAt(13) !== 58 || text.charCodeAt(16) !== 58) return false;
  const century = twoDigitsAt(text, 0);
  const yearOfCentury = twoDigitsAt(text, 2);
  const month = twoDigitsAt(text, 5);
  const day = twoDigitsAt(text, 8);
  const hour = twoDigitsAt(text, 11);
  const minute = twoDigitsAt(text, 14);
  const second = twoDigitsAt(text, 17);
  if ((century | yearOfCentury | month | day | hour | minute | second) < 0) return false;
  if (!isCalendarDay(century * 100 + yearOfCentury, month, day)) return false;
  let end = 19;
  if (text.charCodeAt(end) === 46) {
    end++;
    const fractionStart = end;
    for (let digit = text.charCodeAt(end) - 48; digit >= 0 && digit <= 9; digit = text.charCodeAt(end) - 48) end++;
    if (end === fractionStart) return false;
  }
  const zone = text.charCodeAt(end);
  if ((zone === 90 || zone === 122) && end + 1 === text.length) return isClockTime(hour, minute, second, 0);
  if ((zone !== 43 && zone !== 45) || end + 6 !== text.length || text.charCodeAt(end + 3) !== 58) return false;
  const offsetHour = twoDigitsAt(text, end + 1);
  const offsetMinute = twoDigitsAt(text, end + 4);
  if (offsetHour < 0 || offsetMinute < 0 || offsetHour > 23 || offsetMinute > 59) return false;
  return isClockTime(hour, minute, second, (zone === 45 ? -1 : 1) * (offsetHour * 60 + offsetMinute));
}

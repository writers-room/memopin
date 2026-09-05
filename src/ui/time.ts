/**
 * 목록에 붙는 상대 시각. 시안의 "방금 / 12분 전 / 1시간 전 / 어제 / 3일 전"을 만드는 함수다.
 * 7일이 넘으면 "9월 3일"처럼 날짜로 적는다 — 그쯤 되면 "n일 전"이 오히려 안 읽힌다.
 *
 * 경계는 달력이 아니라 경과 시간으로 센다(자정을 넘겼는지가 아니라 24시간이 지났는지).
 * 동기화로 시계가 조금 어긋난 파일이 와서 미래가 되면 "방금"으로 본다.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = now.getTime() - t;
  if (diff < MINUTE) return '방금';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}분 전`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}시간 전`;
  if (diff < 2 * DAY) return '어제';
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}일 전`;
  const d = new Date(t);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// Events from Google Calendar and Microsoft Graph, read into one shape and laid out by day.
// Pure functions only. The page is in Japan time (no daylight saving), so a fixed offset is enough.

export const TIME_ZONE_OFFSET = "+09:00";
const OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Availability = "busy" | "tentative" | "free" | "away";

export interface CalEvent {
  connectionId: string;
  title: string;
  allDay: boolean;
  // Epoch milliseconds. All-day events run from midnight of the first day to midnight after the
  // last day, in Japan time.
  start: number;
  end: number;
  availability: Availability;
  location?: string;
  link?: string;
}

const NO_TITLE = "(件名なし)";

export function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00${TIME_ZONE_OFFSET}`);
}

export function dateOf(ms: number): string {
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return dateOf(dayStart(date) + days * DAY_MS);
}

export function timeOf(ms: number): string {
  return new Date(ms + OFFSET_MS).toISOString().slice(11, 16);
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function dayLabel(date: string): string {
  const d = new Date(dayStart(date) + OFFSET_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAYS[d.getUTCDay()]})`;
}

export function isDate(value: string | null): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(dayStart(value)) && dateOf(dayStart(value)) === value;
}

// ---- Google Calendar (events.list with singleEvents=true) ----

export interface GoogleEvent {
  status?: string;
  summary?: string;
  eventType?: string;
  transparency?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  location?: string;
  htmlLink?: string;
}

export function fromGoogle(connectionId: string, item: GoogleEvent): CalEvent | null {
  if (item.status === "cancelled") return null;
  // Working locations are a marker on the day, not time taken.
  if (item.eventType === "workingLocation") return null;
  const response = item.attendees?.find((a) => a.self)?.responseStatus;
  if (response === "declined") return null;
  let availability: Availability = "busy";
  if (item.eventType === "outOfOffice") availability = "away";
  else if (item.transparency === "transparent") availability = "free";
  else if (response === "needsAction" || response === "tentative") availability = "tentative";

  const allDay = !!item.start?.date;
  const start = allDay ? dayStart(item.start!.date!) : Date.parse(item.start?.dateTime ?? "");
  const end = allDay ? dayStart(item.end?.date ?? addDays(item.start!.date!, 1)) : Date.parse(item.end?.dateTime ?? "");
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return {
    connectionId,
    title: item.summary?.trim() || NO_TITLE,
    allDay,
    start,
    end: Math.max(end, start),
    availability,
    ...(item.location ? { location: item.location } : {}),
    ...(item.htmlLink ? { link: item.htmlLink } : {}),
  };
}

// ---- Microsoft Graph (calendarView, with Prefer: outlook.timezone="Tokyo Standard Time") ----

export interface GraphEvent {
  subject?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  showAs?: string;
  responseStatus?: { response?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  webLink?: string;
}

// Graph gives local times without an offset ("2026-12-01T09:00:00.0000000") in the zone asked for.
function graphTime(value: string | undefined, timeZone: string | undefined): number {
  if (!value) return Number.NaN;
  const base = value.replace(/(\.\d{3})\d*$/, "$1");
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(base)) return Date.parse(base);
  return Date.parse(`${base}${timeZone === "UTC" ? "Z" : TIME_ZONE_OFFSET}`);
}

export function fromGraph(connectionId: string, item: GraphEvent): CalEvent | null {
  if (item.isCancelled) return null;
  const response = item.responseStatus?.response;
  if (response === "declined") return null;
  let availability: Availability = "busy";
  if (item.showAs === "oof") availability = "away";
  else if (item.showAs === "free" || item.showAs === "workingElsewhere") availability = "free";
  else if (item.showAs === "tentative" || response === "tentativelyAccepted" || (response === "notResponded" && !item.isOrganizer)) availability = "tentative";

  const start = graphTime(item.start?.dateTime, item.start?.timeZone);
  const end = graphTime(item.end?.dateTime, item.end?.timeZone);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const location = item.location?.displayName?.trim();
  return {
    connectionId,
    title: item.subject?.trim() || NO_TITLE,
    allDay: !!item.isAllDay,
    start,
    end: Math.max(end, start),
    availability,
    ...(location ? { location } : {}),
    ...(item.webLink ? { link: item.webLink } : {}),
  };
}

// ---- Laying out by day ----

export interface DayItem {
  event: CalEvent;
  // "09:00" or "" when the event started on an earlier day.
  from: string;
  // "10:30" or "" when it goes on into a later day.
  to: string;
  past: boolean;
  // Overlaps a busy event of another calendar (a double booking across organizations).
  conflict: boolean;
}

export interface Day {
  date: string;
  label: string;
  today: boolean;
  allDay: DayItem[];
  timed: DayItem[];
}

function takesTime(e: CalEvent): boolean {
  return !e.allDay && e.availability !== "free";
}

export function conflicts(events: CalEvent[]): Set<CalEvent> {
  const timed = events.filter(takesTime).sort((a, b) => a.start - b.start);
  const out = new Set<CalEvent>();
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j].start < timed[i].end; j++) {
      if (timed[i].connectionId !== timed[j].connectionId && timed[j].end > timed[i].start) {
        out.add(timed[i]);
        out.add(timed[j]);
      }
    }
  }
  return out;
}

export function layoutDays(events: CalEvent[], from: string, days: number, now: number): Day[] {
  const clash = conflicts(events);
  const today = dateOf(now);
  const sorted = [...events].sort((a, b) => a.start - b.start || b.end - a.end || a.title.localeCompare(b.title));
  const out: Day[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const begin = dayStart(date);
    const finish = begin + DAY_MS;
    const day: Day = { date, label: dayLabel(date), today: date === today, allDay: [], timed: [] };
    for (const e of sorted) {
      // Zero-length events show on the day they are at.
      const overlaps = e.start < finish && (e.end > begin || (e.end === e.start && e.start >= begin));
      if (!overlaps) continue;
      const item: DayItem = {
        event: e,
        from: e.allDay || e.start < begin ? "" : timeOf(e.start),
        to: e.allDay || e.end > finish ? "" : timeOf(e.end),
        past: e.end <= now && e.end !== e.start ? true : e.end === e.start && e.start < now,
        conflict: clash.has(e),
      };
      // An event that covers the whole day reads as an all-day one.
      if (e.allDay || (e.start <= begin && e.end >= finish)) day.allDay.push(item);
      else day.timed.push(item);
    }
    out.push(day);
  }
  return out;
}

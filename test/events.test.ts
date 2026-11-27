import { describe, expect, it } from "vitest";
import { addDays, conflicts, dateOf, dayLabel, fromGoogle, fromGraph, isDate, layoutDays } from "../src/events";

const jst = (s: string) => Date.parse(`${s}+09:00`);

describe("dates in Japan time", () => {
  it("reads the day of an instant in Japan time", () => {
    expect(dateOf(Date.parse("2026-11-30T15:30:00Z"))).toBe("2026-12-01");
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(dayLabel("2026-11-30")).toBe("11/30(月)");
  });
  it("accepts real dates only", () => {
    expect(isDate("2026-02-28")).toBe(true);
    expect(isDate("2026-02-30")).toBe(false);
    expect(isDate("x")).toBe(false);
    expect(isDate(null)).toBe(false);
  });
});

describe("fromGoogle", () => {
  it("skips cancelled, declined and working-location events", () => {
    expect(fromGoogle("a", { status: "cancelled" })).toBeNull();
    expect(fromGoogle("a", { eventType: "workingLocation", start: { date: "2026-12-01" }, end: { date: "2026-12-02" } })).toBeNull();
    expect(
      fromGoogle("a", { start: { dateTime: "2026-12-01T10:00:00+09:00" }, end: { dateTime: "2026-12-01T11:00:00+09:00" }, attendees: [{ self: true, responseStatus: "declined" }] }),
    ).toBeNull();
  });
  it("reads timed, all-day, tentative and free events", () => {
    const timed = fromGoogle("a", { summary: "定例", start: { dateTime: "2026-12-01T10:00:00+09:00" }, end: { dateTime: "2026-12-01T11:00:00+09:00" }, attendees: [{ self: true, responseStatus: "needsAction" }] });
    expect(timed).toMatchObject({ title: "定例", allDay: false, start: jst("2026-12-01T10:00:00"), availability: "tentative" });
    const allDay = fromGoogle("a", { start: { date: "2026-12-01" }, end: { date: "2026-12-03" }, transparency: "transparent" });
    expect(allDay).toMatchObject({ title: "(件名なし)", allDay: true, start: jst("2026-12-01T00:00:00"), end: jst("2026-12-03T00:00:00"), availability: "free" });
  });
});

describe("fromGraph", () => {
  it("reads local times in the requested zone", () => {
    const e = fromGraph("u", {
      subject: "現場",
      start: { dateTime: "2026-12-01T09:00:00.0000000", timeZone: "Tokyo Standard Time" },
      end: { dateTime: "2026-12-01T10:30:00.0000000", timeZone: "Tokyo Standard Time" },
      showAs: "busy",
      responseStatus: { response: "organizer" },
      location: { displayName: "本社" },
    });
    expect(e).toMatchObject({ title: "現場", start: jst("2026-12-01T09:00:00"), end: jst("2026-12-01T10:30:00"), availability: "busy", location: "本社" });
  });
  it("reads UTC times and the response", () => {
    const e = fromGraph("u", { start: { dateTime: "2026-12-01T00:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-12-01T01:00:00.0000000", timeZone: "UTC" }, responseStatus: { response: "notResponded" } });
    expect(e).toMatchObject({ start: Date.parse("2026-12-01T00:00:00Z"), availability: "tentative" });
    expect(fromGraph("u", { isCancelled: true })).toBeNull();
    expect(fromGraph("u", { responseStatus: { response: "declined" }, start: { dateTime: "2026-12-01T00:00:00" }, end: { dateTime: "2026-12-01T01:00:00" } })).toBeNull();
  });
});

const ev = (connectionId: string, from: string, to: string, extra = {}) => ({
  connectionId,
  title: `${connectionId} ${from}`,
  allDay: false,
  start: jst(from),
  end: jst(to),
  availability: "busy" as const,
  ...extra,
});

describe("conflicts", () => {
  it("marks overlaps between different calendars only", () => {
    const a = ev("nvt", "2026-12-01T10:00:00", "2026-12-01T11:00:00");
    const b = ev("ubs", "2026-12-01T10:30:00", "2026-12-01T11:30:00");
    const c = ev("nvt", "2026-12-01T10:45:00", "2026-12-01T12:00:00");
    const d = ev("ubs", "2026-12-01T11:00:00", "2026-12-01T12:00:00", { availability: "free" });
    const back = ev("ubs", "2026-12-01T13:00:00", "2026-12-01T14:00:00");
    const touching = ev("nvt", "2026-12-01T14:00:00", "2026-12-01T15:00:00");
    const set = conflicts([a, b, c, d, back, touching]);
    expect([...set].map((e) => e.title).sort()).toEqual([a.title, b.title, c.title].sort());
  });
});

describe("layoutDays", () => {
  it("puts events on the days they cover", () => {
    const now = jst("2026-12-01T12:00:00");
    const morning = ev("nvt", "2026-12-01T09:00:00", "2026-12-01T10:00:00");
    const overnight = ev("ubs", "2026-12-01T22:00:00", "2026-12-02T02:00:00");
    const trip = { ...ev("nvt", "2026-12-02T00:00:00", "2026-12-04T00:00:00"), allDay: true };
    const days = layoutDays([trip, overnight, morning], "2026-12-01", 3, now);
    expect(days.map((d) => d.date)).toEqual(["2026-12-01", "2026-12-02", "2026-12-03"]);
    expect(days[0].today).toBe(true);
    expect(days[0].timed.map((i) => [i.from, i.to, i.past])).toEqual([
      ["09:00", "10:00", true],
      ["22:00", "", false],
    ]);
    expect(days[1].timed.map((i) => [i.from, i.to])).toEqual([["", "02:00"]]);
    expect(days[1].allDay).toHaveLength(1);
    expect(days[2].allDay).toHaveLength(1);
    expect(days[2].timed).toHaveLength(0);
  });
});

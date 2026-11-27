import css from "./client/app.css";
import type { User } from "./env";
import type { Day, DayItem } from "./events";
import type { SourceResult } from "./sources";
import type { Connection } from "./store";

export const COLORS = ["teal", "blue", "orange", "purple", "pink", "green"] as const;
export type Color = (typeof COLORS)[number];
const COLOR_NAMES: Record<Color, string> = { teal: "青緑", blue: "青", orange: "橙", purple: "紫", pink: "桃", green: "緑" };

export function isColor(value: string | null): value is Color {
  return COLORS.includes(value as Color);
}

function version(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
export const CSS_PATH = "/assets/app.css";
export const CSS_TEXT: string = css;
const CSS_URL = `${CSS_PATH}?v=${version(css)}`;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const e = escapeHtml;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f766e">
<meta name="robots" content="noindex">
<title>${e(title)}</title>
<link rel="stylesheet" href="${CSS_URL}">
</head>
<body>
${body}
</body>
</html>`;
}

export function messagePage(title: string, detail: string, link = { href: "/", text: "予定へ戻る" }): string {
  return layout(
    title,
    `<main class="center"><h1>${e(title)}</h1>${detail ? `<p class="muted">${e(detail)}</p>` : ""}<p><a href="${e(link.href)}">${e(link.text)}</a></p></main>`,
  );
}

export function signInPage(next: string): string {
  return layout(
    "予定",
    `<main class="center"><h1>予定</h1><p class="muted">組織ごとのカレンダーを 1 つにまとめて見る画面です。</p>
<p><a class="nav" href="/auth/login?next=${encodeURIComponent(next)}">サインイン</a></p></main>`,
  );
}

function colorClass(c: Pick<Connection, "color">): string {
  return `c-${isColor(c.color) ? c.color : "teal"}`;
}

function item(i: DayItem, byId: Map<string, Connection>): string {
  const c = byId.get(i.event.connectionId);
  const classes = ["event", c ? colorClass(c) : "", i.event.allDay ? "allday" : "", i.past ? "past" : "", i.event.availability].filter(Boolean).join(" ");
  const time = i.event.allDay
    ? `<span class="time">終日</span>`
    : `<span class="time">${i.from ? e(i.from) : "前日〜"}<span class="to">${i.to ? e(i.to) : "翌日へ"}</span></span>`;
  const badges = [
    i.conflict ? `<span class="badge clash">重なり</span>` : "",
    i.event.availability === "tentative" ? `<span class="badge">仮</span>` : "",
    i.event.availability === "free" ? `<span class="badge">空き</span>` : "",
    i.event.availability === "away" ? `<span class="badge">不在</span>` : "",
  ].join("");
  const meta = `<span class="meta"><span class="org ${c ? colorClass(c) : ""}">${e(c?.name ?? "")}</span>${i.event.location ? `<span>${e(i.event.location)}</span>` : ""}${badges}</span>`;
  const inner = `${time}<span class="body"><span class="title">${e(i.event.title)}</span>${meta}</span>`;
  // Links go to the calendar's own page (Google Calendar, Outlook on the web).
  return i.event.link && /^https:\/\//.test(i.event.link)
    ? `<li><a class="${classes}" href="${e(i.event.link)}" target="_blank" rel="noopener noreferrer">${inner}</a></li>`
    : `<li><div class="${classes}">${inner}</div></li>`;
}

function day(d: Day, byId: Map<string, Connection>): string {
  const items = [...d.allDay, ...d.timed];
  return `<section class="day${d.today ? " today" : ""}" id="d-${d.date}">
<h2>${e(d.label)}</h2>
${items.length ? `<ul class="events">${items.map((i) => item(i, byId)).join("")}</ul>` : `<p class="empty">予定はありません</p>`}
</section>`;
}

export interface AgendaView {
  user: User;
  from: string;
  prev: string;
  next: string;
  isThisWeek: boolean;
  days: Day[];
  results: SourceResult[];
}

export function agendaPage(v: AgendaView): string {
  const byId = new Map(v.results.map((r) => [r.connection.id, r.connection]));
  const sources = v.results.length
    ? `<ul class="sources">${v.results
        .map((r) => `<li class="${colorClass(r.connection)}"><span class="dot"></span><span class="muted">${e(r.connection.name)}${r.error ? " ⚠" : ""}</span></li>`)
        .join("")}</ul>`
    : "";
  const failed = v.results.filter((r) => r.error);
  const alerts = failed
    .map(
      (r) =>
        `<p class="alert"><strong>${e(r.connection.name)}</strong> の予定を読めませんでした。${e(r.error!.message)}${
          r.error!.kind === "reconnect" || r.error!.kind === "refused" ? ` <a href="/connections">接続の画面へ</a>` : ""
        }</p>`,
    )
    .join("");
  const body = v.results.length
    ? v.days.map((d) => day(d, byId)).join("")
    : `<p class="alert">まだカレンダーをつないでいません。<a href="/connections">接続の画面</a>で、組織の Heddleway をつないでください。</p>`;
  return layout(
    "予定",
    `<header class="bar">
  <a class="brand" href="/">予定</a>
  <a class="nav" href="/?from=${v.prev}" aria-label="前の週">‹</a>
  ${v.isThisWeek ? "" : `<a class="nav" href="/">今日</a>`}
  <a class="nav" href="/?from=${v.next}" aria-label="次の週">›</a>
  <a class="nav" href="/connections" aria-label="接続">⚙</a>
</header>
<main class="page">
${sources}
${alerts}
${body}
<nav class="more"><a href="/?from=${v.prev}">前の週</a><a href="/?from=${v.next}">次の週</a></nav>
</main>`,
  );
}

export interface PresetGateway {
  name: string;
  url: string;
}

function colorOptions(selected: string): string {
  return COLORS.map((c) => `<option value="${c}"${c === selected ? " selected" : ""}>${COLOR_NAMES[c]}</option>`).join("");
}

export function connectionsPage(user: User, connections: Connection[], presets: PresetGateway[], notice?: string): string {
  const cards = connections
    .map(
      (c) => `<div class="card">
  <div class="head"><span class="dot ${colorClass(c)}"></span><strong>${e(c.name)}</strong></div>
  <p class="muted">${e(new URL(c.gateway).host)}${c.organization ? `(${e(c.organization)})` : ""} ・ ${c.service === "graph" ? "Microsoft 365 の予定表" : "Google Calendar"}</p>
  ${c.problem || !c.tokens ? `<p class="problem">${e(c.problem ?? "つなぎ直しが要ります")}</p>` : ""}
  <form method="post" action="/connections/${c.id}" class="row">
    <input name="name" value="${e(c.name)}" maxlength="40" aria-label="表示名" required>
    <select name="color" aria-label="色">${colorOptions(c.color)}</select>
    <button class="secondary">保存</button>
  </form>
  <div class="actions">
    <form method="post" action="/connections/start" class="inline">
      <input type="hidden" name="gateway" value="${e(c.gateway)}"><input type="hidden" name="name" value="${e(c.name)}"><input type="hidden" name="color" value="${e(c.color)}">
      <button class="secondary">つなぎ直す</button>
    </form>
    <form method="post" action="/connections/${c.id}/delete" class="inline"><button class="danger">外す</button></form>
  </div>
</div>`,
    )
    .join("");
  const unused = presets.filter((p) => !connections.some((c) => c.gateway === p.url));
  const nextColor = COLORS[connections.length % COLORS.length];
  return layout(
    "接続",
    `<header class="bar"><a class="brand" href="/">予定</a><a class="nav" href="/">予定へ</a></header>
<main class="page">
<h2>つないでいるカレンダー</h2>
${notice ? `<p class="alert">${e(notice)}</p>` : ""}
${cards || `<p class="muted">まだありません。</p>`}
<h2>組織の Heddleway をつなぐ</h2>
<p class="muted">その組織の Heddleway に、管理者がこのアプリ(<code>${e("heddleway-calendar")}</code>)を登録している必要があります。つなぐと、その組織のアカウントでサインインして許可する画面に移ります。</p>
<form method="post" action="/connections/start" class="card">
  <label for="gateway">Heddleway の URL</label>
  <input id="gateway" name="gateway" type="url" list="presets" placeholder="https://gateway.example.com" required>
  <datalist id="presets">${unused.map((p) => `<option value="${e(p.url)}">${e(p.name)}</option>`).join("")}</datalist>
  <div class="row">
    <div><label for="name">表示名</label><input id="name" name="name" maxlength="40" placeholder="例: UBS" required></div>
    <div><label for="color">色</label><select id="color" name="color">${colorOptions(nextColor)}</select></div>
  </div>
  <div class="actions"><button>つなぐ</button></div>
</form>
${unused.length ? `<p class="muted">候補: ${unused.map((p) => `${e(p.name)}(${e(new URL(p.url).host)})`).join("、")}</p>` : ""}
<p class="muted">${e(user.email)} でサインイン中 ・ <form method="post" action="/auth/logout" class="inline"><button class="link">サインアウト</button></form></p>
</main>`,
  );
}

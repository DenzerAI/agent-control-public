// Gemeinsame Quelle fuer Feiertage und Urlaub im Fokus-Kalender.
// Wird von FokusApp.tsx (Desktop-Wochenansicht) und MobileFokus.tsx
// (Mobile-Tagesansicht) genutzt, damit Pfingstsonntag, Pfingstmontag
// und Urlaubsfenster ueberall gleich aussehen.

// Deutsche Feiertage (bundesweit + Schleswig-Holstein).
export const HOLIDAYS_DE: Record<string, string> = {
  '2026-01-01': 'Neujahr',
  '2026-04-03': 'Karfreitag',
  '2026-04-05': 'Ostersonntag',
  '2026-04-06': 'Ostermontag',
  '2026-05-01': 'Tag der Arbeit',
  '2026-05-14': 'Christi Himmelfahrt',
  '2026-05-24': 'Pfingstsonntag',
  '2026-05-25': 'Pfingstmontag',
  '2026-10-03': 'Tag der Dt. Einheit',
  '2026-10-31': 'Reformationstag',
  '2026-12-25': '1. Weihnachtstag',
  '2026-12-26': '2. Weihnachtstag',
  '2027-01-01': 'Neujahr',
  '2027-03-26': 'Karfreitag',
  '2027-03-28': 'Ostersonntag',
  '2027-03-29': 'Ostermontag',
  '2027-05-01': 'Tag der Arbeit',
  '2027-05-06': 'Christi Himmelfahrt',
  '2027-05-16': 'Pfingstsonntag',
  '2027-05-17': 'Pfingstmontag',
  '2027-10-03': 'Tag der Dt. Einheit',
  '2027-10-31': 'Reformationstag',
  '2027-12-25': '1. Weihnachtstag',
  '2027-12-26': '2. Weihnachtstag',
}

// Urlaubsfenster (Christians eigene Abwesenheiten). Wird wie Feiertage
// gerendert: gestreifter Hintergrund, warm-orange Label.
export const VACATIONS: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  const ranges: [string, string][] = []
  for (const [from, to] of ranges) {
    const d = new Date(from + 'T00:00:00')
    const end = new Date(to + 'T00:00:00')
    while (d <= end) {
      out[d.toISOString().slice(0, 10)] = 'Urlaub'
      d.setDate(d.getDate() + 1)
    }
  }
  return out
})()

export function dayMarker(iso: string): { holiday?: string; isWeekend: boolean } {
  const d = new Date(iso + 'T00:00:00')
  const dow = d.getDay()
  return {
    holiday: HOLIDAYS_DE[iso] || VACATIONS[iso],
    isWeekend: dow === 0 || dow === 6,
  }
}

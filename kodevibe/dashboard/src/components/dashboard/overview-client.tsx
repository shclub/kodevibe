'use client'

import { DateFilter } from './date-filter'

export function OverviewClient({ from, to }: { from?: string; to?: string }) {
  return <DateFilter from={from} to={to} />
}

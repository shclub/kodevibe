import { CompareClient } from './compare-client'

export const dynamic = 'force-dynamic'

// Compare is a general feature available to any signed-in user (not admin-only).
export default function ComparePage() {
  return <CompareClient />
}

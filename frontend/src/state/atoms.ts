import { atomWithStorage } from 'jotai/utils'
import { DematAccount } from '@/types/DematLedger'

export const selectedDematAccountAtom = atomWithStorage<DematAccount | null>(
	'demat-ledger-selected-account',
	null,
)

export type StatusFilter = 'Unreconciled' | 'Reconciled' | 'Ignored' | 'All'

export const statusFilterAtom = atomWithStorage<StatusFilter>('demat-ledger-status-filter', 'Unreconciled')

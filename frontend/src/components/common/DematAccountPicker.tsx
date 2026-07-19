import { useEffect } from 'react'
import { useAtom } from 'jotai'
import { useFrappeGetCall } from 'frappe-react-sdk'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import _ from '@/lib/translate'
import { cn } from '@/lib/utils'
import { selectedDematAccountAtom } from '@/state/atoms'
import { DematAccount } from '@/types/DematLedger'

export const useDematAccounts = () => {
    const { data, error, isLoading, mutate } = useFrappeGetCall<{ message: DematAccount[] }>(
        'demat_ledger.api.get_demat_accounts',
        {},
        'demat-accounts',
        { revalidateOnFocus: false },
    )
    return { accounts: data?.message ?? [], error, isLoading, mutate }
}

const DematAccountPicker = ({ className }: { className?: string }) => {
    const { accounts } = useDematAccounts()
    const [selectedAccount, setSelectedAccount] = useAtom(selectedDematAccountAtom)

    // Keep the persisted selection in sync with the server (deleted/renamed accounts).
    useEffect(() => {
        if (accounts.length === 0) return
        const current = accounts.find((account) => account.name === selectedAccount?.name)
        if (!current) {
            setSelectedAccount(accounts[0])
        } else if (JSON.stringify(current) !== JSON.stringify(selectedAccount)) {
            setSelectedAccount(current)
        }
    }, [accounts, selectedAccount, setSelectedAccount])

    return (
        <Select
            value={selectedAccount?.name ?? ''}
            onValueChange={(value) => {
                const account = accounts.find((a) => a.name === value)
                if (account) setSelectedAccount(account)
            }}
        >
            <SelectTrigger variant="outline" className={cn('min-w-64 w-fit', className)}>
                <SelectValue placeholder={_('Select Demat Account')} />
            </SelectTrigger>
            <SelectContent>
                {accounts.map((account) => (
                    <SelectItem key={account.name} value={account.name}>
                        <span className="flex items-center gap-2">
                            <span>{account.account_name}</span>
                            {(account.unreconciled_count ?? 0) > 0 && (
                                <Badge theme="orange">{account.unreconciled_count}</Badge>
                            )}
                        </span>
                    </SelectItem>
                ))}
                {accounts.length === 0 && (
                    <div className="px-2 py-1.5 text-sm text-ink-gray-5">
                        {_('No demat accounts found. Create one in the Desk first.')}
                    </div>
                )}
            </SelectContent>
        </Select>
    )
}

export default DematAccountPicker

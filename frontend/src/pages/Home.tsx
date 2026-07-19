import { useMemo, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { useFrappeGetCall, useFrappePostCall } from 'frappe-react-sdk'
import { Link } from 'react-router'
import { toast } from 'sonner'
import {
    CheckCircle2Icon,
    EyeOffIcon,
    HomeIcon,
    Loader2Icon,
    PlayIcon,
    SettingsIcon,
    Undo2Icon,
    UploadIcon,
} from 'lucide-react'
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import ErrorBanner from '@/components/ui/error-banner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import DematAccountPicker from '@/components/common/DematAccountPicker'
import LinkFieldCombobox from '@/components/common/LinkFieldCombobox'
import RulesDialog from '@/components/features/Rules/RulesDialog'
import { formatDate } from '@/lib/date'
import { formatCurrency } from '@/lib/numbers'
import _ from '@/lib/translate'
import { cn } from '@/lib/utils'
import { selectedDematAccountAtom, statusFilterAtom, StatusFilter } from '@/state/atoms'
import { DematTransaction } from '@/types/DematLedger'

const useTransactions = (dematAccount: string | undefined, status: StatusFilter) => {
    const swrKey = dematAccount ? `demat-transactions-${dematAccount}-${status}` : null
    return useFrappeGetCall<{ message: DematTransaction[] }>(
        'demat_ledger.api.get_transactions',
        {
            demat_account: dematAccount,
            status: status === 'All' ? undefined : status,
        },
        swrKey,
        { revalidateOnFocus: false },
    )
}

const Home = () => {
    const selectedAccount = useAtomValue(selectedDematAccountAtom)
    const [statusFilter, setStatusFilter] = useAtom(statusFilterAtom)

    const { data, error, isLoading, mutate } = useTransactions(selectedAccount?.name, statusFilter)
    const transactions = useMemo(() => data?.message ?? [], [data])

    const [selected, setSelected] = useState<Set<string>>(new Set())
    // Per-row contra account overrides (transaction name -> account), applied on top of
    // the rule-recommended account.
    const [overrides, setOverrides] = useState<Record<string, string>>({})

    const { call: bulkCreate, loading: creating } = useFrappePostCall('demat_ledger.api.bulk_create_journal_entries')
    const { call: markIgnored, loading: ignoring } = useFrappePostCall('demat_ledger.api.mark_transactions_ignored')
    const { call: resetTransaction, loading: resetting } = useFrappePostCall('demat_ledger.api.reset_transaction')
    const { call: runRules, loading: runningRules } = useFrappePostCall(
        'demat_ledger.demat_ledger.doctype.demat_transaction_rule.demat_transaction_rule.run_rule_evaluation',
    )

    const busy = creating || ignoring || resetting

    const refresh = () => {
        setSelected(new Set())
        mutate()
    }

    const contraAccountFor = (transaction: DematTransaction) =>
        overrides[transaction.name] ?? transaction.recommended_account ?? ''

    const selectableTransactions = useMemo(
        () => transactions.filter((t) => t.status === 'Unreconciled'),
        [transactions],
    )

    const selectedCreatable = useMemo(
        () =>
            [...selected].filter((name) => {
                const transaction = transactions.find((t) => t.name === name)
                return transaction && contraAccountFor(transaction)
            }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [selected, transactions, overrides],
    )

    const toggleAll = (checked: boolean) => {
        setSelected(checked ? new Set(selectableTransactions.map((t) => t.name)) : new Set())
    }

    const toggleOne = (name: string, checked: boolean) => {
        setSelected((prev) => {
            const next = new Set(prev)
            if (checked) {
                next.add(name)
            } else {
                next.delete(name)
            }
            return next
        })
    }

    const onCreateJournalEntries = () => {
        const rows = selectedCreatable.map((name) => {
            const transaction = transactions.find((t) => t.name === name)!
            return {
                name,
                contra_account: contraAccountFor(transaction),
                party_type: transaction.party_type,
                party: transaction.party,
            }
        })

        bulkCreate({ transactions: rows })
            .then((response) => {
                const results = (response?.message ?? []) as Array<{ status: string; error?: string }>
                const created = results.filter((r) => r.status === 'Created').length
                const failed = results.filter((r) => r.status === 'Failed')
                if (created) {
                    toast.success(_('{0} Journal Entries created.', [created.toString()]))
                }
                failed.forEach((f) => toast.error(f.error ?? _('Journal Entry creation failed.')))
                refresh()
            })
            .catch(() => toast.error(_('Could not create Journal Entries.')))
    }

    const onIgnore = () => {
        markIgnored({ transaction_names: [...selected] })
            .then(() => {
                toast.success(_('Transactions ignored.'))
                refresh()
            })
            .catch(() => toast.error(_('Could not ignore the transactions.')))
    }

    const onReset = (name: string) => {
        resetTransaction({ transaction_name: name })
            .then(() => {
                toast.success(_('Transaction reset. Any linked Journal Entry was cancelled.'))
                refresh()
            })
            .catch(() => toast.error(_('Could not reset the transaction.')))
    }

    const onRunRules = () => {
        runRules({ force_evaluate: true })
            .then(() => {
                toast.success(_('Rules re-evaluated for all unreconciled transactions.'))
                refresh()
            })
            .catch(() => toast.error(_('Could not run the rules.')))
    }

    const allSelected = selectableTransactions.length > 0 && selected.size === selectableTransactions.length

    return (
        <div className="flex flex-col gap-4 p-4">
            <div className="flex items-center justify-between">
                <Breadcrumb>
                    <BreadcrumbList>
                        <BreadcrumbItem>
                            <a href="/desk" className="text-ink-gray-7">
                                <HomeIcon size={16} />
                            </a>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                            <BreadcrumbPage>{_('Demat Ledger')}</BreadcrumbPage>
                        </BreadcrumbItem>
                    </BreadcrumbList>
                </Breadcrumb>

                <div className="flex items-center gap-2">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="outline" size="sm" onClick={onRunRules} disabled={runningRules}>
                                {runningRules ? <Loader2Icon className="size-4 animate-spin" /> : <PlayIcon />}
                                {_('Run Rules')}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            {_('Re-evaluate all matching rules against unreconciled transactions.')}
                        </TooltipContent>
                    </Tooltip>
                    <RulesDialog
                        company={selectedAccount?.company}
                        onRulesChanged={refresh}
                        trigger={
                            <Button variant="outline" size="sm">
                                <SettingsIcon />
                                {_('Rules')}
                            </Button>
                        }
                    />
                    <Button size="sm" asChild>
                        <Link to="/import">
                            <UploadIcon />
                            {_('Import Ledger')}
                        </Link>
                    </Button>
                </div>
            </div>

            <div className="flex items-center justify-between">
                <DematAccountPicker />
                <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                    <TabsList variant="subtle">
                        <TabsTrigger value="Unreconciled">{_('Unreconciled')}</TabsTrigger>
                        <TabsTrigger value="Reconciled">{_('Reconciled')}</TabsTrigger>
                        <TabsTrigger value="Ignored">{_('Ignored')}</TabsTrigger>
                        <TabsTrigger value="All">{_('All')}</TabsTrigger>
                    </TabsList>
                </Tabs>
            </div>

            {error && <ErrorBanner error={error} />}

            {selected.size > 0 && (
                <div className="flex items-center justify-between rounded border border-outline-gray-2 bg-surface-gray-1 px-3 py-2">
                    <span className="text-sm text-ink-gray-7">
                        {_('{0} selected', [selected.size.toString()])}
                        {selectedCreatable.length < selected.size && (
                            <span className="text-ink-gray-5">
                                {' '}
                                ({_('{0} without a contra account will be skipped', [
                                    (selected.size - selectedCreatable.length).toString(),
                                ])})
                            </span>
                        )}
                    </span>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={onIgnore} disabled={busy}>
                            <EyeOffIcon />
                            {_('Ignore')}
                        </Button>
                        <Button size="sm" onClick={onCreateJournalEntries} disabled={busy || selectedCreatable.length === 0}>
                            {creating ? <Loader2Icon className="size-4 animate-spin" /> : <CheckCircle2Icon />}
                            {_('Create {0} Journal Entries', [selectedCreatable.length.toString()])}
                        </Button>
                    </div>
                </div>
            )}

            {isLoading ? (
                <div className="flex items-center justify-center p-16">
                    <Loader2Icon className="size-6 animate-spin text-ink-gray-5" />
                </div>
            ) : transactions.length === 0 ? (
                <Empty>
                    <EmptyHeader>
                        <EmptyMedia>
                            <UploadIcon />
                        </EmptyMedia>
                        <EmptyTitle>{_('No transactions found')}</EmptyTitle>
                        <EmptyDescription>
                            {selectedAccount
                                ? _('Import a broker ledger to get started.')
                                : _('Create a Demat Account in the Desk, then import a broker ledger.')}
                        </EmptyDescription>
                    </EmptyHeader>
                </Empty>
            ) : (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-8">
                                <Checkbox
                                    checked={allSelected}
                                    disabled={selectableTransactions.length === 0}
                                    onCheckedChange={(checked) => toggleAll(checked === true)}
                                />
                            </TableHead>
                            <TableHead>{_('Date')}</TableHead>
                            <TableHead>{_('Voucher Type')}</TableHead>
                            <TableHead>{_('Narration')}</TableHead>
                            <TableHead className="text-end">{_('Debit')}</TableHead>
                            <TableHead className="text-end">{_('Credit')}</TableHead>
                            <TableHead>{_('Status')}</TableHead>
                            <TableHead className="min-w-64">{_('Contra Ledger')}</TableHead>
                            <TableHead>{_('Rule')}</TableHead>
                            <TableHead className="w-10"></TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {transactions.map((transaction) => {
                            const isUnreconciled = transaction.status === 'Unreconciled'
                            const contraAccount = contraAccountFor(transaction)

                            return (
                                <TableRow
                                    key={transaction.name}
                                    className={cn(selected.has(transaction.name) && 'bg-surface-gray-1')}
                                >
                                    <TableCell className="w-8">
                                        <Checkbox
                                            checked={selected.has(transaction.name)}
                                            disabled={!isUnreconciled}
                                            onCheckedChange={(checked) => toggleOne(transaction.name, checked === true)}
                                        />
                                    </TableCell>
                                    <TableCell className="whitespace-nowrap">{formatDate(transaction.date)}</TableCell>
                                    <TableCell className="max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap">
                                        {transaction.voucher_type || '-'}
                                    </TableCell>
                                    <TableCell
                                        className="max-w-[280px] overflow-hidden text-ellipsis whitespace-nowrap"
                                        title={transaction.description}
                                    >
                                        {transaction.description}
                                    </TableCell>
                                    <TableCell className="text-end font-numeric text-ink-red-3">
                                        {transaction.debit ? formatCurrency(transaction.debit, transaction.currency) : ''}
                                    </TableCell>
                                    <TableCell className="text-end font-numeric text-ink-green-3">
                                        {transaction.credit ? formatCurrency(transaction.credit, transaction.currency) : ''}
                                    </TableCell>
                                    <TableCell>
                                        <StatusBadge transaction={transaction} />
                                    </TableCell>
                                    <TableCell>
                                        {isUnreconciled ? (
                                            transaction.recommended_action === 'Ignore' ? (
                                                <span className="text-sm text-ink-gray-5">{_('Rule suggests ignoring')}</span>
                                            ) : (
                                                <LinkFieldCombobox
                                                    doctype="Account"
                                                    filters={[
                                                        ['company', '=', selectedAccount?.company ?? ''],
                                                        ['is_group', '=', 0],
                                                    ]}
                                                    value={contraAccount}
                                                    onChange={(value) =>
                                                        setOverrides((prev) => ({ ...prev, [transaction.name]: value }))
                                                    }
                                                    placeholder={_('Select contra ledger')}
                                                    size="sm"
                                                    buttonClassName="w-full max-w-72"
                                                />
                                            )
                                        ) : transaction.journal_entry ? (
                                            <a
                                                href={`/desk/journal-entry/${transaction.journal_entry}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-sm underline underline-offset-4"
                                            >
                                                {transaction.journal_entry}
                                            </a>
                                        ) : (
                                            <span className="text-sm text-ink-gray-5">-</span>
                                        )}
                                    </TableCell>
                                    <TableCell className="max-w-[140px] overflow-hidden text-ellipsis whitespace-nowrap">
                                        {transaction.matched_rule ? (
                                            <Tooltip>
                                                <TooltipTrigger>
                                                    <Badge theme="blue">{transaction.matched_rule}</Badge>
                                                </TooltipTrigger>
                                                <TooltipContent>
                                                    {_('Matched rule: {0}', [transaction.matched_rule])}
                                                </TooltipContent>
                                            </Tooltip>
                                        ) : (
                                            <span className="text-sm text-ink-gray-5">-</span>
                                        )}
                                    </TableCell>
                                    <TableCell className="w-10">
                                        {transaction.status !== 'Unreconciled' && (
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        isIconButton
                                                        disabled={busy}
                                                        onClick={() => onReset(transaction.name)}
                                                    >
                                                        <Undo2Icon />
                                                    </Button>
                                                </TooltipTrigger>
                                                <TooltipContent>
                                                    {transaction.journal_entry
                                                        ? _('Undo: cancel the Journal Entry and mark as unreconciled')
                                                        : _('Mark as unreconciled again')}
                                                </TooltipContent>
                                            </Tooltip>
                                        )}
                                    </TableCell>
                                </TableRow>
                            )
                        })}
                    </TableBody>
                </Table>
            )}
        </div>
    )
}

const StatusBadge = ({ transaction }: { transaction: DematTransaction }) => {
    if (transaction.status === 'Reconciled') {
        return <Badge theme="green">{_('Reconciled')}</Badge>
    }
    if (transaction.status === 'Ignored') {
        return <Badge theme="gray">{_('Ignored')}</Badge>
    }
    if (transaction.recommended_account || transaction.recommended_action === 'Ignore') {
        return <Badge theme="orange">{_('Suggested')}</Badge>
    }
    return <Badge theme="gray">{_('Unreconciled')}</Badge>
}

export default Home

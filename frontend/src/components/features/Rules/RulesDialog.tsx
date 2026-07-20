import { ReactNode, useEffect, useMemo, useState } from 'react'
import { useFrappeDeleteDoc, useFrappeGetCall, useFrappeGetDocList, useFrappeUpdateDoc } from 'frappe-react-sdk'
import { toast } from 'sonner'
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import ErrorBanner from '@/components/ui/error-banner'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import LinkFieldCombobox from '@/components/common/LinkFieldCombobox'
import _ from '@/lib/translate'
import { DematRuleCompanyAccount, DematTransactionRule } from '@/types/DematLedger'
import RuleForm from './RuleForm'

type View = { mode: 'list' } | { mode: 'create' } | { mode: 'edit'; rule: string }

type Props = {
    /** Default company for the company filter and to prefill a new rule's first row -
     * typically the currently selected demat account's company. The filter can still be
     * changed or cleared to manage rules across every company. */
    company?: string
    trigger: ReactNode
    onRulesChanged?: () => void
}

const RulesDialog = ({ company, trigger, onRulesChanged }: Props) => {
    const [open, setOpen] = useState(false)
    const [view, setView] = useState<View>({ mode: 'list' })
    // '' means "All Companies". Defaults to the context company whenever the dialog re-opens.
    const [companyFilter, setCompanyFilter] = useState(company ?? '')

    useEffect(() => {
        if (open) setCompanyFilter(company ?? '')
    }, [open, company])

    // Rule priority is a single global sequence (one rule can span several companies), so the
    // list is always fetched and displayed in plain priority order.
    const { data, error, mutate } = useFrappeGetDocList<DematTransactionRule>(
        'Demat Transaction Rule',
        {
            fields: ['name', 'rule_name', 'priority', 'action', 'transaction_type'],
            orderBy: { field: 'priority', order: 'asc' },
            limit: 0,
        },
        open ? 'demat-rules' : null,
        { revalidateOnFocus: false },
    )
    const allRules = data ?? []

    // The list API doesn't expand child tables, so fetch every rule's company/ledger rows in
    // one lightweight query and group them by parent rule name. This goes through a dedicated
    // backend endpoint rather than the generic list API: reading child-doctype fields via
    // frappe.client.get_list requires a `parent` (parent doctype) argument that the typed
    // useFrappeGetDocList hook has no way to pass, so it would silently return only `name`.
    const { data: companyRowsResponse } = useFrappeGetCall<{
        message: (DematRuleCompanyAccount & { parent: string })[]
    }>('demat_ledger.api.get_rule_company_accounts', {}, open ? 'demat-rule-company-accounts' : null, {
        revalidateOnFocus: false,
    })

    const companiesByRule = useMemo(() => {
        const map: Record<string, DematRuleCompanyAccount[]> = {}
        for (const row of companyRowsResponse?.message ?? []) {
            ;(map[row.parent] ??= []).push(row)
        }
        return map
    }, [companyRowsResponse])

    const rules = companyFilter
        ? allRules.filter((rule) => companiesByRule[rule.name!]?.some((row) => row.company === companyFilter))
        : allRules

    const { deleteDoc, loading: deleting } = useFrappeDeleteDoc()
    const { updateDoc, loading: reordering } = useFrappeUpdateDoc()

    const refresh = () => {
        mutate()
        onRulesChanged?.()
    }

    const onDelete = (name: string) => {
        deleteDoc('Demat Transaction Rule', name)
            .then(() => {
                toast.success(_('Rule deleted.'))
                refresh()
            })
            .catch(() => toast.error(_('Could not delete the rule.')))
    }

    // Swap priorities with the neighbour to move a rule up/down. Since only these two rules'
    // priority values change (and they're already distinct), this is safe even when the list
    // is filtered by company - it can't collide with or reorder any other rule.
    const onMove = (index: number, direction: -1 | 1) => {
        const rule = rules[index]
        const neighbour = rules[index + direction]
        if (!rule || !neighbour) return

        Promise.all([
            updateDoc('Demat Transaction Rule', rule.name!, { priority: neighbour.priority }),
            updateDoc('Demat Transaction Rule', neighbour.name!, { priority: rule.priority }),
        ])
            .then(() => refresh())
            .catch(() => toast.error(_('Could not reorder the rules.')))
    }

    const onOpenChange = (nextOpen: boolean) => {
        setOpen(nextOpen)
        if (!nextOpen) setView({ mode: 'list' })
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogTrigger asChild>{trigger}</DialogTrigger>
            <DialogContent className="min-w-5xl max-h-[85vh] overflow-y-auto">
                {view.mode === 'list' && (
                    <>
                        <DialogHeader>
                            <DialogTitle>{_('Matching Rules')}</DialogTitle>
                            <DialogDescription>
                                {_(
                                    'Rules are evaluated by priority (top first); the first matching rule decides the contra ledger for a transaction. A rule can apply to several companies at once, each with its own ledger mapping.',
                                )}
                            </DialogDescription>
                        </DialogHeader>

                        {error && <ErrorBanner error={error} />}

                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                                <Label className="text-sm text-ink-gray-6">{_('Company')}</Label>
                                <LinkFieldCombobox
                                    doctype="Company"
                                    value={companyFilter}
                                    onChange={(value) => setCompanyFilter(value)}
                                    placeholder={_('All Companies')}
                                    size="sm"
                                    buttonClassName="min-w-48"
                                />
                                {companyFilter && (
                                    <Button variant="ghost" size="sm" onClick={() => setCompanyFilter('')}>
                                        {_('Clear')}
                                    </Button>
                                )}
                            </div>
                            <Button size="sm" onClick={() => setView({ mode: 'create' })}>
                                <PlusIcon />
                                {_('New Rule')}
                            </Button>
                        </div>

                        {rules.length === 0 ? (
                            <Empty>
                                <EmptyHeader>
                                    <EmptyMedia>
                                        <PlusIcon />
                                    </EmptyMedia>
                                    <EmptyTitle>{_('No rules yet')}</EmptyTitle>
                                    <EmptyDescription>
                                        {_('Create a rule to auto-recommend the contra ledger based on the narration or voucher type.')}
                                    </EmptyDescription>
                                </EmptyHeader>
                            </Empty>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className="w-20">{_('Priority')}</TableHead>
                                        <TableHead>{_('Rule')}</TableHead>
                                        <TableHead>{_('Companies')}</TableHead>
                                        <TableHead>{_('Action')}</TableHead>
                                        <TableHead>{_('Direction')}</TableHead>
                                        <TableHead className="w-28"></TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {rules.map((rule, index) => {
                                        const rows = companiesByRule[rule.name!] ?? []

                                        return (
                                            <TableRow key={rule.name}>
                                                <TableCell>
                                                    <div className="flex items-center gap-1">
                                                        <span className="w-5 text-center">{rule.priority}</span>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            isIconButton
                                                            disabled={index === 0 || reordering}
                                                            onClick={() => onMove(index, -1)}
                                                        >
                                                            <ArrowUpIcon />
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            isIconButton
                                                            disabled={index === rules.length - 1 || reordering}
                                                            onClick={() => onMove(index, 1)}
                                                        >
                                                            <ArrowDownIcon />
                                                        </Button>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="font-medium">{rule.rule_name}</TableCell>
                                                <TableCell className="max-w-[280px]">
                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <span className="block cursor-default overflow-hidden text-ellipsis whitespace-nowrap text-sm text-ink-gray-6">
                                                                {rows.length === 0
                                                                    ? '-'
                                                                    : rows.map((row) => row.company).join(', ')}
                                                            </span>
                                                        </TooltipTrigger>
                                                        {rows.length > 0 && (
                                                            <TooltipContent>
                                                                <div className="flex flex-col gap-0.5">
                                                                    {rows.map((row) => (
                                                                        <span key={row.company}>
                                                                            {row.company}
                                                                            {rule.action === 'Create Journal Entry' &&
                                                                                `: ${[row.debit_account, row.credit_account]
                                                                                    .filter(Boolean)
                                                                                    .join(' / ')}`}
                                                                        </span>
                                                                    ))}
                                                                </div>
                                                            </TooltipContent>
                                                        )}
                                                    </Tooltip>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge theme={rule.action === 'Ignore' ? 'gray' : 'blue'}>{_(rule.action)}</Badge>
                                                </TableCell>
                                                <TableCell>{_(rule.transaction_type || 'Any')}</TableCell>
                                                <TableCell>
                                                    <div className="flex items-center justify-end gap-1">
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            isIconButton
                                                            onClick={() => setView({ mode: 'edit', rule: rule.name! })}
                                                        >
                                                            <PencilIcon />
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            isIconButton
                                                            disabled={deleting}
                                                            onClick={() => onDelete(rule.name!)}
                                                        >
                                                            <Trash2Icon className="text-ink-red-3" />
                                                        </Button>
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        )
                                    })}
                                </TableBody>
                            </Table>
                        )}
                    </>
                )}

                {view.mode !== 'list' && (
                    <RuleForm
                        defaultCompany={companyFilter || company}
                        ruleName={view.mode === 'edit' ? view.rule : undefined}
                        onDone={() => {
                            setView({ mode: 'list' })
                            refresh()
                        }}
                        onCancel={() => setView({ mode: 'list' })}
                    />
                )}
            </DialogContent>
        </Dialog>
    )
}

export default RulesDialog

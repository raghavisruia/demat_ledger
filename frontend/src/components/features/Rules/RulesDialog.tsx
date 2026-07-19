import { ReactNode, useState } from 'react'
import { useFrappeDeleteDoc, useFrappeGetDocList, useFrappeUpdateDoc } from 'frappe-react-sdk'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import _ from '@/lib/translate'
import { DematTransactionRule } from '@/types/DematLedger'
import RuleForm from './RuleForm'

type View = { mode: 'list' } | { mode: 'create' } | { mode: 'edit'; rule: string }

type Props = {
    company?: string
    trigger: ReactNode
    onRulesChanged?: () => void
}

const RulesDialog = ({ company, trigger, onRulesChanged }: Props) => {
    const [open, setOpen] = useState(false)
    const [view, setView] = useState<View>({ mode: 'list' })

    const { data, error, mutate } = useFrappeGetDocList<DematTransactionRule>(
        'Demat Transaction Rule',
        {
            fields: ['name', 'rule_name', 'priority', 'action', 'transaction_type', 'debit_account', 'credit_account', 'company'],
            filters: company ? [['company', '=', company]] : [],
            orderBy: { field: 'priority', order: 'asc' },
            limit: 0,
        },
        open ? `demat-rules-${company}` : null,
        { revalidateOnFocus: false },
    )
    const rules = data ?? []

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

    // Swap priorities with the neighbour to move a rule up/down.
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
                                    'Rules are evaluated by priority (top first); the first matching rule decides the contra ledger for a transaction. A rule can match on narration keywords, the broker voucher type, direction and amount.',
                                )}
                            </DialogDescription>
                        </DialogHeader>

                        {error && <ErrorBanner error={error} />}

                        <div className="flex justify-end">
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
                                        <TableHead>{_('Action')}</TableHead>
                                        <TableHead>{_('Direction')}</TableHead>
                                        <TableHead>{_('Contra Ledger(s)')}</TableHead>
                                        <TableHead className="w-28"></TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {rules.map((rule, index) => (
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
                                            <TableCell>
                                                <Badge theme={rule.action === 'Ignore' ? 'gray' : 'blue'}>{_(rule.action)}</Badge>
                                            </TableCell>
                                            <TableCell>{_(rule.transaction_type || 'Any')}</TableCell>
                                            <TableCell className="max-w-[240px] overflow-hidden text-ellipsis whitespace-nowrap text-sm text-ink-gray-6">
                                                {rule.action === 'Ignore'
                                                    ? '-'
                                                    : [rule.debit_account, rule.credit_account].filter(Boolean).join(' / ')}
                                            </TableCell>
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
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </>
                )}

                {view.mode !== 'list' && (
                    <RuleForm
                        company={company}
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

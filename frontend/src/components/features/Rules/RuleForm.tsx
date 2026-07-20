import { useEffect, useState } from 'react'
import { useFrappeCreateDoc, useFrappeGetDoc, useFrappeUpdateDoc } from 'frappe-react-sdk'
import { toast } from 'sonner'
import { PlusIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import LinkFieldCombobox from '@/components/common/LinkFieldCombobox'
import _ from '@/lib/translate'
import { DematRuleCompanyAccount, DematRuleCondition, DematTransactionRule } from '@/types/DematLedger'

const PARTY_TYPES = ['', 'Customer', 'Supplier', 'Employee', 'Shareholder']

const EMPTY_CONDITION: DematRuleCondition = { match_on: 'Narration', check: 'Contains', value: '' }
const EMPTY_COMPANY_ROW: DematRuleCompanyAccount = { company: '' }

const EMPTY_RULE: DematTransactionRule = {
    rule_name: '',
    action: 'Create Journal Entry',
    transaction_type: 'Any',
    conditions: [{ ...EMPTY_CONDITION }],
    companies: [{ ...EMPTY_COMPANY_ROW }],
}

type Props = {
    /** Prefills the first company row for a brand-new rule. Ignored once editing an existing one. */
    defaultCompany?: string
    /** When set, the form edits this rule; otherwise it creates a new one. */
    ruleName?: string
    onDone: () => void
    onCancel: () => void
}

const RuleForm = ({ defaultCompany, ruleName, onDone, onCancel }: Props) => {
    const isEditing = Boolean(ruleName)

    const { data: existingRule } = useFrappeGetDoc<DematTransactionRule>(
        'Demat Transaction Rule',
        ruleName,
        ruleName ? undefined : null,
    )

    const [rule, setRule] = useState<DematTransactionRule>({
        ...EMPTY_RULE,
        companies: defaultCompany ? [{ company: defaultCompany }] : [{ ...EMPTY_COMPANY_ROW }],
    })

    useEffect(() => {
        if (existingRule) {
            setRule({
                ...existingRule,
                conditions: existingRule.conditions?.length ? existingRule.conditions : [{ ...EMPTY_CONDITION }],
                companies: existingRule.companies?.length ? existingRule.companies : [{ ...EMPTY_COMPANY_ROW }],
            })
        }
    }, [existingRule])

    const { createDoc, loading: creating } = useFrappeCreateDoc()
    const { updateDoc, loading: updating } = useFrappeUpdateDoc()
    const saving = creating || updating

    const set = <K extends keyof DematTransactionRule>(key: K, value: DematTransactionRule[K]) =>
        setRule((prev) => ({ ...prev, [key]: value }))

    const setCondition = (index: number, patch: Partial<DematRuleCondition>) =>
        setRule((prev) => ({
            ...prev,
            conditions: prev.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)),
        }))

    const setCompanyRow = (index: number, patch: Partial<DematRuleCompanyAccount>) =>
        setRule((prev) => ({
            ...prev,
            companies: prev.companies.map((row, i) => (i === index ? { ...row, ...patch } : row)),
        }))

    // Changing a row's company invalidates its previously chosen ledger accounts (they belong
    // to the old company), so clear them rather than leaving a mismatched combination.
    const onChangeRowCompany = (index: number, company: string) =>
        setCompanyRow(index, { company, debit_account: undefined, credit_account: undefined })

    const usedCompanies = new Set(rule.companies.map((row) => row.company).filter(Boolean))
    const hasDuplicateCompany = usedCompanies.size !== rule.companies.filter((row) => row.company).length

    const showDebitAccount = rule.action === 'Create Journal Entry' && rule.transaction_type !== 'Credit'
    const showCreditAccount = rule.action === 'Create Journal Entry' && rule.transaction_type !== 'Debit'

    const rowIsComplete = (row: DematRuleCompanyAccount) => {
        if (!row.company) return false
        if (rule.action === 'Ignore') return true
        if (rule.transaction_type === 'Debit') return Boolean(row.debit_account)
        if (rule.transaction_type === 'Credit') return Boolean(row.credit_account)
        return Boolean(row.debit_account || row.credit_account)
    }

    const isValid =
        rule.rule_name.trim() &&
        rule.companies.length > 0 &&
        !hasDuplicateCompany &&
        rule.companies.every(rowIsComplete) &&
        rule.conditions.some((c) => c.value.trim())

    const onSave = () => {
        const payload = {
            ...rule,
            conditions: rule.conditions.filter((c) => c.value.trim()),
            companies: rule.companies
                .filter((row) => row.company)
                .map((row) => ({
                    company: row.company,
                    debit_account: showDebitAccount ? row.debit_account : undefined,
                    credit_account: showCreditAccount ? row.credit_account : undefined,
                })),
            party_type: rule.party ? rule.party_type : undefined,
            party: rule.party || undefined,
        }

        const request = isEditing
            ? updateDoc('Demat Transaction Rule', ruleName!, payload)
            : createDoc('Demat Transaction Rule', payload)

        request
            .then(() => {
                toast.success(isEditing ? _('Rule updated.') : _('Rule created.'))
                onDone()
            })
            .catch((error) => {
                const message = error?._server_messages
                    ? JSON.parse(JSON.parse(error._server_messages)[0])?.message
                    : _('Could not save the rule.')
                toast.error(message)
            })
    }

    return (
        <div className="flex flex-col gap-4">
            <DialogHeader>
                <DialogTitle>{isEditing ? _('Edit Rule') : _('New Rule')}</DialogTitle>
                <DialogDescription>
                    {_(
                        'When a transaction matches this rule, the contra ledger for its company is recommended automatically. The demat ledger account is always the other leg of the Journal Entry.',
                    )}
                </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                    <Label>{_('Rule Name')}<span className="text-ink-red-3">*</span></Label>
                    <Input
                        value={rule.rule_name}
                        disabled={isEditing}
                        onChange={(e) => set('rule_name', e.target.value)}
                        placeholder={_('e.g. Trade Bills')}
                    />
                </div>
                <div className="flex flex-col gap-2">
                    <Label>{_('Action')}</Label>
                    <Select value={rule.action} onValueChange={(v) => set('action', v as DematTransactionRule['action'])}>
                        <SelectTrigger variant="outline">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="Create Journal Entry">{_('Create Journal Entry')}</SelectItem>
                            <SelectItem value="Ignore">{_('Ignore (e.g. opening balance rows)')}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
                <div className="flex flex-col gap-2">
                    <Label>{_('Transaction Type')}</Label>
                    <Select
                        value={rule.transaction_type}
                        onValueChange={(v) => set('transaction_type', v as DematTransactionRule['transaction_type'])}
                    >
                        <SelectTrigger variant="outline">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="Any">{_('Any')}</SelectItem>
                            <SelectItem value="Debit">{_('Debit (reduces broker balance)')}</SelectItem>
                            <SelectItem value="Credit">{_('Credit (increases broker balance)')}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex flex-col gap-2">
                    <Label>{_('Min Amount')}</Label>
                    <Input
                        type="number"
                        value={rule.min_amount ?? ''}
                        onChange={(e) => set('min_amount', e.target.value ? Number(e.target.value) : undefined)}
                    />
                </div>
                <div className="flex flex-col gap-2">
                    <Label>{_('Max Amount')}</Label>
                    <Input
                        type="number"
                        value={rule.max_amount ?? ''}
                        onChange={(e) => set('max_amount', e.target.value ? Number(e.target.value) : undefined)}
                    />
                </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
                <Label>{_('Conditions')}<span className="text-ink-red-3">*</span></Label>
                <p className="text-xs text-ink-gray-5">
                    {_('The rule matches if ANY condition matches. Match against the narration text or the broker voucher type (e.g. TRADE BILL, PAYOUT).')}
                </p>
                <div className="flex flex-col gap-2">
                    {rule.conditions.map((condition, index) => (
                        <div key={index} className="flex items-center gap-2">
                            <Select
                                value={condition.match_on}
                                onValueChange={(v) => setCondition(index, { match_on: v as DematRuleCondition['match_on'] })}
                            >
                                <SelectTrigger variant="outline" className="w-40">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="Narration">{_('Narration')}</SelectItem>
                                    <SelectItem value="Voucher Type">{_('Voucher Type')}</SelectItem>
                                </SelectContent>
                            </Select>
                            <Select
                                value={condition.check}
                                onValueChange={(v) => setCondition(index, { check: v as DematRuleCondition['check'] })}
                            >
                                <SelectTrigger variant="outline" className="w-36">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="Contains">{_('Contains')}</SelectItem>
                                    <SelectItem value="Starts With">{_('Starts With')}</SelectItem>
                                    <SelectItem value="Ends With">{_('Ends With')}</SelectItem>
                                    <SelectItem value="Regex">{_('Regex')}</SelectItem>
                                </SelectContent>
                            </Select>
                            <Input
                                className="flex-1"
                                value={condition.value}
                                onChange={(e) => setCondition(index, { value: e.target.value })}
                                placeholder={_('Keyword, e.g. trade bill')}
                            />
                            <Button
                                variant="ghost"
                                size="sm"
                                isIconButton
                                disabled={rule.conditions.length === 1}
                                onClick={() =>
                                    setRule((prev) => ({
                                        ...prev,
                                        conditions: prev.conditions.filter((_c, i) => i !== index),
                                    }))
                                }
                            >
                                <Trash2Icon />
                            </Button>
                        </div>
                    ))}
                    <div>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                                setRule((prev) => ({ ...prev, conditions: [...prev.conditions, { ...EMPTY_CONDITION }] }))
                            }
                        >
                            <PlusIcon />
                            {_('Add Condition')}
                        </Button>
                    </div>
                </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
                <Label>{_('Companies & Ledger Mapping')}<span className="text-ink-red-3">*</span></Label>
                <p className="text-xs text-ink-gray-5">
                    {_(
                        'This rule only matches a transaction whose company is listed below. Add a row per company; each gets its own contra ledger(s), so one rule can cover the same kind of entry (e.g. TRADE BILL) across every company you operate in.',
                    )}
                </p>
                {rule.transaction_type === 'Any' && rule.action === 'Create Journal Entry' && (
                    <p className="text-xs text-ink-gray-6">
                        {_('Tip: set both a debit and credit account per row to handle e.g. a TRADE BILL that can be either a buy (debit) or a sell (credit) with different ledgers.')}
                    </p>
                )}
                {hasDuplicateCompany && (
                    <p className="text-xs text-ink-red-3">{_('The same company is added more than once.')}</p>
                )}

                <div className="flex flex-col gap-3">
                    {rule.companies.map((row, index) => (
                        <div key={index} className="flex flex-col gap-2 rounded border border-outline-gray-2 p-3">
                            <div className="flex items-center gap-2">
                                <div className="flex-1">
                                    <Label className="mb-1.5 block text-xs text-ink-gray-6">{_('Company')}</Label>
                                    <LinkFieldCombobox
                                        doctype="Company"
                                        value={row.company}
                                        onChange={(value) => onChangeRowCompany(index, value)}
                                        placeholder={_('Select company')}
                                    />
                                </div>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    isIconButton
                                    className="mt-5"
                                    disabled={rule.companies.length === 1}
                                    onClick={() =>
                                        setRule((prev) => ({
                                            ...prev,
                                            companies: prev.companies.filter((_r, i) => i !== index),
                                        }))
                                    }
                                >
                                    <Trash2Icon />
                                </Button>
                            </div>

                            {rule.action === 'Create Journal Entry' && row.company && (
                                <div className="grid grid-cols-2 gap-3">
                                    {showDebitAccount && (
                                        <div className="flex flex-col gap-1.5">
                                            <Label className="text-xs text-ink-gray-6">
                                                {_('Contra Account (Debit)')}
                                                {rule.transaction_type === 'Debit' && <span className="text-ink-red-3">*</span>}
                                            </Label>
                                            <LinkFieldCombobox
                                                doctype="Account"
                                                filters={[
                                                    ['company', '=', row.company],
                                                    ['is_group', '=', 0],
                                                ]}
                                                value={row.debit_account}
                                                onChange={(value) => setCompanyRow(index, { debit_account: value })}
                                                placeholder={_('Select account')}
                                            />
                                        </div>
                                    )}
                                    {showCreditAccount && (
                                        <div className="flex flex-col gap-1.5">
                                            <Label className="text-xs text-ink-gray-6">
                                                {_('Contra Account (Credit)')}
                                                {rule.transaction_type === 'Credit' && <span className="text-ink-red-3">*</span>}
                                            </Label>
                                            <LinkFieldCombobox
                                                doctype="Account"
                                                filters={[
                                                    ['company', '=', row.company],
                                                    ['is_group', '=', 0],
                                                ]}
                                                value={row.credit_account}
                                                onChange={(value) => setCompanyRow(index, { credit_account: value })}
                                                placeholder={_('Select account')}
                                            />
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                    <div>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                                setRule((prev) => ({ ...prev, companies: [...prev.companies, { ...EMPTY_COMPANY_ROW }] }))
                            }
                        >
                            <PlusIcon />
                            {_('Add Company')}
                        </Button>
                    </div>
                </div>
            </div>

            {rule.action === 'Create Journal Entry' && (
                <>
                    <Separator />
                    <div className="grid grid-cols-2 gap-4">
                        <div className="flex flex-col gap-2">
                            <Label>{_('Party Type (optional)')}</Label>
                            <Select
                                value={rule.party_type ?? ''}
                                onValueChange={(v) => setRule((prev) => ({ ...prev, party_type: v || undefined, party: undefined }))}
                            >
                                <SelectTrigger variant="outline">
                                    <SelectValue placeholder={_('None')} />
                                </SelectTrigger>
                                <SelectContent>
                                    {PARTY_TYPES.filter(Boolean).map((partyType) => (
                                        <SelectItem key={partyType} value={partyType}>
                                            {_(partyType)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        {rule.party_type && (
                            <div className="flex flex-col gap-2">
                                <Label>{_('Party')}</Label>
                                <LinkFieldCombobox
                                    doctype={rule.party_type}
                                    value={rule.party}
                                    onChange={(value) => set('party', value)}
                                    placeholder={_('Select party')}
                                />
                            </div>
                        )}
                    </div>
                </>
            )}

            <Separator />

            <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={onCancel} disabled={saving}>
                    {_('Cancel')}
                </Button>
                <Button onClick={onSave} disabled={!isValid || saving}>
                    {saving ? _('Saving...') : isEditing ? _('Save Changes') : _('Create Rule')}
                </Button>
            </div>
        </div>
    )
}

export default RuleForm

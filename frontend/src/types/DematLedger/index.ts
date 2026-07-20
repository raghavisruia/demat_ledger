export interface DematAccount {
	name: string
	account_name: string
	broker_name: string
	client_code?: string
	company: string
	/** GL ledger account */
	account: string
	disabled?: 0 | 1
	unreconciled_count?: number
}

export interface DematImportColumnMap {
	name?: string
	header_text: string
	index: number
	maps_to: string
	variable?: string
}

export interface DematLedgerImportLog {
	name: string
	creation: string
	demat_account: string
	file: string
	status: 'Not Started' | 'Completed'
	currency?: string
	number_of_transactions: number
	start_date?: string
	end_date?: string
	closing_balance?: number
	total_debits?: number
	total_credits?: number
	total_debit_transactions?: number
	total_credit_transactions?: number
	detected_date_format?: string
	detected_amount_format?: string
	detected_header_index?: number
	column_mapping?: DematImportColumnMap[]
	pdf_tables?: string
}

export interface DematTransaction {
	name: string
	date: string
	demat_account: string
	company?: string
	status: 'Unreconciled' | 'Reconciled' | 'Ignored'
	debit?: number
	credit?: number
	balance?: number
	currency?: string
	description?: string
	voucher_type?: string
	voucher_no?: string
	reference_number?: string
	matched_rule?: string
	recommended_action?: 'Create Journal Entry' | 'Ignore' | ''
	recommended_account?: string
	party_type?: string
	party?: string
	journal_entry?: string
	import_log?: string
}

export interface DematRuleCondition {
	name?: string
	match_on: 'Narration' | 'Voucher Type'
	check: 'Contains' | 'Starts With' | 'Ends With' | 'Regex'
	value: string
}

export interface DematRuleCompanyAccount {
	name?: string
	company: string
	debit_account?: string
	credit_account?: string
}

export interface DematTransactionRule {
	name?: string
	rule_name: string
	priority?: number
	action: 'Create Journal Entry' | 'Ignore'
	rule_description?: string
	transaction_type: 'Any' | 'Debit' | 'Credit'
	min_amount?: number
	max_amount?: number
	conditions: DematRuleCondition[]
	/** One row per company this rule applies to, each with its own contra ledger(s). */
	companies: DematRuleCompanyAccount[]
	party_type?: string
	party?: string
}

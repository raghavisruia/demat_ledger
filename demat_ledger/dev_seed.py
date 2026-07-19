# Copyright (c) 2026, Raghav Ruia and contributors
# For license information, please see license.txt

"""
Development seed + end-to-end smoke test.

Run with:
    bench --site <site> execute demat_ledger.dev_seed.run

Creates (if missing) a test company, GL accounts, a Demat Account, matching rules,
imports a sample broker ledger CSV modeled on a Motilal Oswal ledger report, runs
rule evaluation and bulk-creates Journal Entries. Prints a summary of each stage.
"""

import frappe

COMPANY = "Frappe Tech"
ABBR = "FT"

SAMPLE_CSV = """Voc Date,Eff Date,Voucher Type,Voucher No,Cheque No,Amount,Balance,Narration
19 Sep 2025,19 Sep 2025,Journal Voucher,2526000249749111,,-864.26,-864.26,Administrative Charges
04 Jul 2025,04 Jul 2025,PAYOUT,2526000216403746,,-168.50,0.00,QUARTERLY SETTLEMENT PAYOUT
03 Jul 2025,03 Jul 2025,PAYOUT,2526000211378363,,"-1,24,500.00",168.50,MONEY PAYOUT
02 Jul 2025,02 Jul 2025,Journal Voucher,2526000206507451,,-33.19,"1,24,668.50",DP Transaction Billing Dated: 2025-07-01
01 Jul 2025,02 Jul 2025,TRADE BILL,2526000206434178,,"1,24,625.11","1,24,701.69",NSEEQ M 2025124 01 Jul 2025 Bill Posted
05 Jun 2025,05 Jun 2025,Journal Voucher,2526000167140980,,-1.09,76.58,Being Interest charges for the month of May-2025
15 May 2025,15 May 2025,PAYOUT,2526000144201828,,"-16,900.00",77.67,MONEY PAYOUT
15 May 2025,15 May 2025,Journal Voucher,2526000144140646,,-47.20,"16,977.67",DP Transaction Billing Dated: 2025-05-14
14 May 2025,15 May 2025,TRADE BILL,2526000144129227,,"17,023.41","17,024.87",NSEEQ M 2025090 14 May 2025 Bill Posted
14 May 2025,14 May 2025,PAYOUT,2526000144117118,,"-1,70,704.00",1.46,MONEY PAYOUT
09 May 2025,13 May 2025,TRADE BILL,2526000143903630,,"1,70,879.30","1,70,705.45",NSEEQ M 2025087 09 May 2025 Bill Posted
10 May 2025,10 May 2025,Journal Voucher,2526000143906541,,-48.70,-173.83,DP Transaction Billing Dated: 2025-05-09
08 May 2025,08 May 2025,Journal Voucher,2526000142178642,,-2.45,-125.13,Being Interest charges for the month of April-2025
03 Apr 2025,03 Apr 2025,Journal Voucher,2425000125509720,,-2.48,-122.68,Being Interest charges for the month of March-2025
01 Apr 2025,01 Apr 2025,Open Balance,0,,-120.20,-120.20,Opening Balance
"""


def run():
	ensure_fiscal_years()
	ensure_company()
	accounts = ensure_accounts()
	demat_account = ensure_demat_account(accounts["demat"])
	ensure_rules(accounts)
	import_log = import_sample_csv(demat_account)
	print_detection_summary(import_log)
	insert_and_evaluate(import_log)
	print_recommendations(demat_account)
	create_journal_entries(demat_account)
	frappe.db.commit()


def ensure_fiscal_years():
	for start, end in (("2025-04-01", "2026-03-31"), ("2026-04-01", "2027-03-31")):
		year = f"{start[:4]}-{end[:4]}"
		if not frappe.db.exists("Fiscal Year", year):
			frappe.get_doc(
				{
					"doctype": "Fiscal Year",
					"year": year,
					"year_start_date": start,
					"year_end_date": end,
				}
			).insert()
			print(f"Created Fiscal Year {year}")


def ensure_company():
	if frappe.db.exists("Company", COMPANY):
		return
	frappe.get_doc(
		{
			"doctype": "Company",
			"company_name": COMPANY,
			"abbr": ABBR,
			"default_currency": "INR",
			"country": "India",
		}
	).insert()
	print(f"Created Company {COMPANY}")


def ensure_accounts():
	def make(account_name, parent, account_type=None):
		name = f"{account_name} - {ABBR}"
		if not frappe.db.exists("Account", name):
			frappe.get_doc(
				{
					"doctype": "Account",
					"account_name": account_name,
					"parent_account": f"{parent} - {ABBR}",
					"company": COMPANY,
					"account_type": account_type,
				}
			).insert()
			print(f"Created Account {name}")
		return name

	return {
		"demat": make("Motilal Oswal Broker", "Current Assets"),
		"investments": make("Investment in Securities", "Current Assets"),
		"bank": make("HDFC Bank", "Bank Accounts", "Bank"),
		"dp_charges": make("DP Charges", "Indirect Expenses"),
		"interest": make("Interest on Broker Ledger", "Indirect Expenses"),
		"admin_charges": make("Broker Administrative Charges", "Indirect Expenses"),
	}


def ensure_demat_account(demat_gl_account):
	name = "Motilal Oswal - MHDM4434"
	if not frappe.db.exists("Demat Account", name):
		frappe.get_doc(
			{
				"doctype": "Demat Account",
				"account_name": name,
				"broker_name": "Motilal Oswal",
				"client_code": "MHDM4434",
				"company": COMPANY,
				"account": demat_gl_account,
			}
		).insert()
		print(f"Created Demat Account {name}")
	return name


def ensure_rules(accounts):
	rules = [
		{
			"rule_name": "Ignore Opening Balance",
			"action": "Ignore",
			"conditions": [{"match_on": "Voucher Type", "check": "Contains", "value": "open balance"}],
		},
		{
			"rule_name": "Trade Bills",
			"action": "Create Journal Entry",
			"transaction_type": "Any",
			"debit_account": accounts["investments"],
			"credit_account": accounts["investments"],
			"conditions": [{"match_on": "Voucher Type", "check": "Contains", "value": "trade bill"}],
		},
		{
			"rule_name": "Money Payouts",
			"action": "Create Journal Entry",
			"transaction_type": "Debit",
			"debit_account": accounts["bank"],
			"conditions": [{"match_on": "Voucher Type", "check": "Contains", "value": "payout"}],
		},
		{
			"rule_name": "DP Charges",
			"action": "Create Journal Entry",
			"transaction_type": "Debit",
			"debit_account": accounts["dp_charges"],
			"conditions": [
				{"match_on": "Narration", "check": "Contains", "value": "dp transaction billing"}
			],
		},
		{
			"rule_name": "Interest Charges",
			"action": "Create Journal Entry",
			"transaction_type": "Debit",
			"debit_account": accounts["interest"],
			"conditions": [{"match_on": "Narration", "check": "Contains", "value": "interest charges"}],
		},
		{
			"rule_name": "Administrative Charges",
			"action": "Create Journal Entry",
			"transaction_type": "Debit",
			"debit_account": accounts["admin_charges"],
			"conditions": [
				{"match_on": "Narration", "check": "Contains", "value": "administrative charges"}
			],
		},
	]

	for rule in rules:
		if frappe.db.exists("Demat Transaction Rule", rule["rule_name"]):
			continue
		frappe.get_doc({"doctype": "Demat Transaction Rule", "company": COMPANY, **rule}).insert()
		print(f"Created Rule {rule['rule_name']}")


def import_sample_csv(demat_account):
	file_doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": "sample_broker_ledger.csv",
			"is_private": 1,
			"content": SAMPLE_CSV,
		}
	).insert()

	import_log = frappe.get_doc(
		{
			"doctype": "Demat Ledger Import Log",
			"demat_account": demat_account,
			"file": file_doc.file_url,
		}
	).insert()
	return import_log


def print_detection_summary(import_log):
	print("\n--- Detection summary ---")
	print("header index:", import_log.detected_header_index)
	print("date format:", import_log.detected_date_format)
	print("amount format:", import_log.detected_amount_format)
	print("transactions:", import_log.number_of_transactions)
	print("period:", import_log.start_date, "to", import_log.end_date)
	print("closing balance:", import_log.closing_balance)
	print("total debits:", import_log.total_debits, "credits:", import_log.total_credits)
	for column in import_log.column_mapping:
		print(f"  col {column.index}: {column.header_text!r} -> {column.maps_to}")


def insert_and_evaluate(import_log):
	import_log.insert_transactions()
	print("\nInserted transactions, status:", import_log.status)


def print_recommendations(demat_account):
	print("\n--- Recommendations ---")
	transactions = frappe.get_all(
		"Demat Transaction",
		filters={"demat_account": demat_account},
		fields=[
			"name",
			"date",
			"debit",
			"credit",
			"voucher_type",
			"matched_rule",
			"recommended_action",
			"recommended_account",
		],
		order_by="date",
	)
	for tx in transactions:
		print(
			f"  {tx.date} dr={tx.debit or 0:>12} cr={tx.credit or 0:>12} "
			f"[{tx.voucher_type}] rule={tx.matched_rule} -> {tx.recommended_action} / {tx.recommended_account}"
		)


def create_journal_entries(demat_account):
	from demat_ledger.api import bulk_create_journal_entries, mark_transactions_ignored

	to_ignore = frappe.get_all(
		"Demat Transaction",
		filters={
			"demat_account": demat_account,
			"status": "Unreconciled",
			"recommended_action": "Ignore",
		},
		pluck="name",
	)
	if to_ignore:
		mark_transactions_ignored(to_ignore)
		print(f"\nIgnored {len(to_ignore)} transaction(s)")

	to_create = frappe.get_all(
		"Demat Transaction",
		filters={
			"demat_account": demat_account,
			"status": "Unreconciled",
			"recommended_action": "Create Journal Entry",
		},
		pluck="name",
	)
	results = bulk_create_journal_entries([{"name": name} for name in to_create])

	print("\n--- Journal Entries ---")
	for result in results:
		print(f"  {result['transaction']}: {result['status']} -> {result.get('journal_entry')}")
		if result["status"] == "Failed":
			print("    error:", result.get("error"))

	from erpnext.accounts.utils import get_balance_on

	demat_gl = frappe.get_cached_value("Demat Account", demat_account, "account")
	print("\nDemat GL balance:", get_balance_on(demat_gl, date="2026-03-31", company=COMPANY))

# Copyright (c) 2026, Raghav Ruia and contributors
# For license information, please see license.txt

import json

import frappe
from frappe import _

from erpnext import get_default_cost_center


@frappe.whitelist(methods=["GET"])
def get_transactions(
	demat_account: str,
	status: str | None = None,
	from_date: str | None = None,
	to_date: str | None = None,
):
	frappe.has_permission("Demat Transaction", ptype="read", throw=True)

	filters = {"demat_account": demat_account}
	if status:
		filters["status"] = status
	if from_date:
		filters["date"] = [">=", from_date]
	if to_date:
		filters["date"] = ["<=", to_date]
	if from_date and to_date:
		filters["date"] = ["between", [from_date, to_date]]

	return frappe.get_all(
		"Demat Transaction",
		filters=filters,
		fields=[
			"name",
			"date",
			"debit",
			"credit",
			"balance",
			"currency",
			"description",
			"voucher_type",
			"voucher_no",
			"reference_number",
			"status",
			"matched_rule",
			"recommended_action",
			"recommended_account",
			"party_type",
			"party",
			"journal_entry",
		],
		order_by="date asc, creation asc",
	)


@frappe.whitelist(methods=["POST"])
def bulk_create_journal_entries(transactions: list | str):
	"""
	Create and submit one Journal Entry per demat transaction.

	``transactions`` is a list of dicts: ``{"name": <Demat Transaction>, "contra_account":
	<optional override>, "party_type": <optional>, "party": <optional>}``. When no override
	is given, the rule-recommended contra account (stored on the transaction) is used.

	The demat account's GL ledger is always one leg: a statement CREDIT (balance with the
	broker goes up) debits the demat ledger and credits the contra account; a statement
	DEBIT does the reverse.
	"""
	frappe.has_permission("Journal Entry", ptype="create", throw=True)
	frappe.has_permission("Journal Entry", ptype="submit", throw=True)
	frappe.has_permission("Demat Transaction", ptype="write", throw=True)

	if isinstance(transactions, str):
		transactions = json.loads(transactions)

	results = []
	total = len(transactions)

	for progress, row in enumerate(transactions, start=1):
		transaction_name = row.get("name") if isinstance(row, dict) else row
		frappe.db.savepoint("demat_je_creation")
		try:
			journal_entry = create_journal_entry(
				transaction_name,
				contra_account=row.get("contra_account") if isinstance(row, dict) else None,
				party_type=row.get("party_type") if isinstance(row, dict) else None,
				party=row.get("party") if isinstance(row, dict) else None,
			)
			results.append(
				{"transaction": transaction_name, "journal_entry": journal_entry, "status": "Created"}
			)
		except Exception:
			frappe.db.rollback(save_point="demat_je_creation")
			results.append(
				{
					"transaction": transaction_name,
					"journal_entry": None,
					"status": "Failed",
					"error": frappe.get_traceback(with_context=False).splitlines()[-1],
				}
			)
			frappe.log_error(
				title="Demat Ledger: Journal Entry creation failed",
				message=frappe.get_traceback(),
			)

		frappe.publish_realtime(
			"demat-ledger-je-progress",
			{"progress": round(progress / total * 100), "total": total},
			user=frappe.session.user,
		)

	return results


def create_journal_entry(
	transaction_name: str,
	contra_account: str | None = None,
	party_type: str | None = None,
	party: str | None = None,
) -> str:
	transaction = frappe.get_doc("Demat Transaction", transaction_name)

	if transaction.status != "Unreconciled":
		frappe.throw(
			_("Transaction {0} is already {1}").format(transaction_name, _(transaction.status))
		)

	contra_account = contra_account or transaction.recommended_account
	if not contra_account:
		frappe.throw(
			_("No contra account for transaction {0}. Set one manually or configure a matching rule.").format(
				transaction_name
			)
		)

	party_type = party_type or transaction.party_type
	party = party or transaction.party

	demat_account = frappe.get_cached_doc("Demat Account", transaction.demat_account)
	amount = transaction.credit or transaction.debit

	if not amount:
		frappe.throw(_("Transaction {0} has no amount").format(transaction_name))

	# Statement credit -> broker owes you more -> debit the demat ledger.
	if transaction.credit:
		demat_leg = {"account": demat_account.account, "debit": amount, "credit": 0}
		contra_leg = {"account": contra_account, "debit": 0, "credit": amount}
	else:
		demat_leg = {"account": demat_account.account, "debit": 0, "credit": amount}
		contra_leg = {"account": contra_account, "debit": amount, "credit": 0}

	if party:
		contra_leg["party_type"] = party_type
		contra_leg["party"] = party

	default_cost_center = get_default_cost_center(demat_account.company)

	journal_entry = frappe.get_doc(
		{
			"doctype": "Journal Entry",
			"voucher_type": "Journal Entry",
			"company": demat_account.company,
			"posting_date": transaction.date,
			"cheque_no": (transaction.voucher_no or transaction.reference_number or transaction.name)[:140],
			"cheque_date": transaction.date,
			"user_remark": build_remark(transaction),
		}
	)

	for leg in (demat_leg, contra_leg):
		cost_center = None
		if frappe.get_cached_value("Account", leg["account"], "report_type") == "Profit and Loss":
			cost_center = default_cost_center

		journal_entry.append(
			"accounts",
			{
				**leg,
				"debit_in_account_currency": leg["debit"],
				"credit_in_account_currency": leg["credit"],
				"cost_center": cost_center,
			},
		)

	journal_entry.insert()
	journal_entry.submit()

	transaction.journal_entry = journal_entry.name
	transaction.status = "Reconciled"
	if contra_account != transaction.recommended_account:
		transaction.recommended_account = contra_account
	transaction.save()

	return journal_entry.name


def build_remark(transaction) -> str:
	parts = [transaction.description or ""]
	if transaction.voucher_type:
		parts.append(_("Broker Voucher Type: {0}").format(transaction.voucher_type))
	if transaction.voucher_no:
		parts.append(_("Broker Voucher No: {0}").format(transaction.voucher_no))
	return "\n".join(part for part in parts if part)


@frappe.whitelist(methods=["POST"])
def mark_transactions_ignored(transaction_names: list | str):
	"""Mark transactions as Ignored (e.g. opening balance lines)."""
	frappe.has_permission("Demat Transaction", ptype="write", throw=True)

	if isinstance(transaction_names, str):
		transaction_names = json.loads(transaction_names)

	for name in transaction_names:
		status = frappe.db.get_value("Demat Transaction", name, "status")
		if status == "Reconciled":
			frappe.throw(_("Transaction {0} is already reconciled and cannot be ignored.").format(name))
		frappe.db.set_value("Demat Transaction", name, "status", "Ignored")

	return {"ignored": len(transaction_names)}


@frappe.whitelist(methods=["POST"])
def reset_transaction(transaction_name: str):
	"""
	Undo a transaction: cancel its Journal Entry (if any) and set it back to Unreconciled.
	"""
	frappe.has_permission("Demat Transaction", ptype="write", throw=True)

	transaction = frappe.get_doc("Demat Transaction", transaction_name)

	if transaction.journal_entry:
		journal_entry = frappe.get_doc("Journal Entry", transaction.journal_entry)
		if journal_entry.docstatus == 1:
			journal_entry.cancel()
		transaction.journal_entry = None

	transaction.status = "Unreconciled"
	transaction.save()

	return transaction.name


@frappe.whitelist(methods=["POST"])
def update_transaction_recommendation(
	transaction_name: str,
	contra_account: str | None = None,
	party_type: str | None = None,
	party: str | None = None,
):
	"""Manually override the recommended contra account / party on a transaction."""
	frappe.has_permission("Demat Transaction", ptype="write", throw=True)

	transaction = frappe.get_doc("Demat Transaction", transaction_name)

	if transaction.status != "Unreconciled":
		frappe.throw(_("Only unreconciled transactions can be updated."))

	transaction.recommended_account = contra_account
	transaction.party_type = party_type if party else None
	transaction.party = party
	if contra_account:
		transaction.recommended_action = "Create Journal Entry"
	transaction.save()

	return transaction.name


@frappe.whitelist(methods=["GET"])
def get_demat_accounts(company: str | None = None):
	"""Demat accounts with their linked GL ledger balance context for the account picker."""
	frappe.has_permission("Demat Account", ptype="read", throw=True)

	filters = {"disabled": 0}
	if company:
		filters["company"] = company

	accounts = frappe.get_all(
		"Demat Account",
		filters=filters,
		fields=["name", "account_name", "broker_name", "client_code", "company", "account"],
		order_by="account_name",
	)

	for account in accounts:
		account["unreconciled_count"] = frappe.db.count(
			"Demat Transaction", {"demat_account": account.name, "status": "Unreconciled"}
		)

	return accounts

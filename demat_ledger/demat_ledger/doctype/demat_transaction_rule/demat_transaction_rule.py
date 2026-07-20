# Copyright (c) 2026, Raghav Ruia and contributors
# For license information, please see license.txt

import re

import frappe
from frappe import _
from frappe.model.document import Document


class DematTransactionRule(Document):
	def before_insert(self):
		"""Assign the next priority number for the new rule.

		Priority is a single global sequence, not scoped per company, since one rule can
		now cover several companies at once.
		"""
		if not self.priority:
			highest_priority = frappe.db.get_value(
				"Demat Transaction Rule", filters={}, fieldname="priority", order_by="priority DESC"
			)
			self.priority = (highest_priority or 0) + 1

	def validate(self):
		if self.min_amount and self.max_amount and self.min_amount > self.max_amount:
			frappe.throw(_("Min amount cannot be greater than max amount."))

		if not self.companies:
			frappe.throw(_("Please add at least one company."))

		seen_companies = set()
		for row in self.companies:
			if row.company in seen_companies:
				frappe.throw(_("Company {0} is added more than once.").format(row.company))
			seen_companies.add(row.company)

		if self.action == "Create Journal Entry":
			self.validate_company_accounts()

		for condition in self.conditions:
			if condition.check == "Regex":
				try:
					re.compile(condition.value)
				except re.error:
					frappe.throw(_("Invalid regex pattern: {0}").format(condition.value))

		if self.party and not self.party_type:
			frappe.throw(_("Party Type is required when a Party is set."))

	def validate_company_accounts(self):
		for row in self.companies:
			if self.transaction_type == "Debit":
				row.credit_account = None
				if not row.debit_account:
					frappe.throw(
						_("Row #{0} ({1}): please set the contra account for debit transactions.").format(
							row.idx, row.company
						)
					)
			elif self.transaction_type == "Credit":
				row.debit_account = None
				if not row.credit_account:
					frappe.throw(
						_("Row #{0} ({1}): please set the contra account for credit transactions.").format(
							row.idx, row.company
						)
					)
			else:
				if not row.debit_account and not row.credit_account:
					frappe.throw(
						_(
							"Row #{0} ({1}): please set a contra account for debit and/or credit transactions."
						).format(row.idx, row.company),
						title=_("Contra Account Missing"),
					)

			for account in (row.debit_account, row.credit_account):
				if not account:
					continue
				account_company, is_group = frappe.get_cached_value("Account", account, ["company", "is_group"])
				if account_company != row.company:
					frappe.throw(
						_("Row #{0}: account {1} does not belong to company {2}.").format(
							row.idx, account, row.company
						)
					)
				if is_group:
					frappe.throw(_("Row #{0}: account {1} is a group account and cannot be used.").format(row.idx, account))

	def on_trash(self):
		"""Unlink this rule from any transactions that matched it"""
		frappe.db.set_value(
			"Demat Transaction",
			{"matched_rule": self.name},
			{"matched_rule": None, "recommended_account": None, "recommended_action": None},
		)

	def after_delete(self):
		"""Rearrange the priorities of the remaining rules"""
		rules = frappe.get_all(
			"Demat Transaction Rule",
			filters={"name": ["!=", self.name]},
			order_by="priority asc",
		)
		for i, rule in enumerate(rules):
			frappe.db.set_value("Demat Transaction Rule", rule.name, "priority", i + 1)

	def evaluate_rule(self, transaction) -> bool:
		"""
		Check whether this rule matches the given transaction: the transaction's company must
		be one of this rule's companies, and (for a "Create Journal Entry" rule) that company's
		row must have a contra account configured for the transaction's direction.
		"""
		company_row = self.get_company_row(transaction.company)
		if not company_row:
			return False

		is_debit = (transaction.debit or 0) > 0

		if self.transaction_type == "Debit" and not is_debit:
			return False

		if self.transaction_type == "Credit" and is_debit:
			return False

		if self.action == "Create Journal Entry" and not self.get_contra_account(transaction):
			return False

		transaction_amount = transaction.debit or transaction.credit

		if self.min_amount and transaction_amount < self.min_amount:
			return False

		if self.max_amount and transaction_amount > self.max_amount:
			return False

		for condition in self.conditions:
			if condition.match_on == "Voucher Type":
				subject = (transaction.voucher_type or "").lower()
			else:
				subject = (transaction.description or "").lower()

			value = (condition.value or "").lower()

			if condition.check == "Contains" and value in subject:
				return True

			if condition.check == "Starts With" and subject.startswith(value):
				return True

			if condition.check == "Ends With" and subject.endswith(value):
				return True

			if condition.check == "Regex" and re.search(value, subject):
				return True

		return False

	def get_company_row(self, company: str):
		return next((row for row in self.companies if row.company == company), None)

	def get_contra_account(self, transaction) -> str | None:
		"""The contra ledger account applicable to the transaction's company and direction."""
		company_row = self.get_company_row(transaction.company)
		if not company_row:
			return None
		if (transaction.debit or 0) > 0:
			return company_row.debit_account
		return company_row.credit_account


@frappe.whitelist(methods=["POST"])
def run_rule_evaluation(force_evaluate: bool = False):
	frappe.has_permission("Demat Transaction", ptype="write", throw=True)
	_run_rule_evaluation(force_evaluate=frappe.utils.sbool(force_evaluate))


def _run_rule_evaluation(force_evaluate=False):
	"""
	Evaluate all rules (by ascending global priority; first match wins) against unreconciled
	demat transactions and stamp the recommendation on each transaction.

	If force_evaluate is True, previously evaluated transactions are evaluated again.
	"""
	rules = frappe.get_all("Demat Transaction Rule", pluck="name", order_by="priority asc")

	filters = {"status": "Unreconciled"}
	if not force_evaluate:
		filters["is_rule_evaluated"] = 0

	transactions = frappe.get_all(
		"Demat Transaction",
		filters=filters,
		fields=["name", "company", "debit", "credit", "description", "voucher_type"],
	)

	if not transactions:
		return

	rule_docs = [frappe.get_doc("Demat Transaction Rule", rule) for rule in rules]

	for transaction in transactions:
		matched_rule = None

		for rule in rule_docs:
			if rule.evaluate_rule(transaction):
				matched_rule = rule
				break

		values = {
			"is_rule_evaluated": 1,
			"matched_rule": matched_rule.name if matched_rule else None,
			"recommended_action": matched_rule.action if matched_rule else None,
			"recommended_account": None,
			"party_type": None,
			"party": None,
		}

		if matched_rule and matched_rule.action == "Create Journal Entry":
			values["recommended_account"] = matched_rule.get_contra_account(transaction)
			if matched_rule.party:
				values["party_type"] = matched_rule.party_type
				values["party"] = matched_rule.party

		frappe.db.set_value("Demat Transaction", transaction.name, values, update_modified=False)

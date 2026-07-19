# Copyright (c) 2026, Raghav Ruia and contributors
# For license information, please see license.txt

import re

import frappe
from frappe import _
from frappe.model.document import Document


class DematTransactionRule(Document):
	def before_insert(self):
		"""Assign the next priority number for the new rule"""
		if not self.priority:
			highest_priority = frappe.db.get_value(
				"Demat Transaction Rule",
				filters={"company": self.company},
				fieldname="priority",
				order_by="priority DESC",
			)
			self.priority = (highest_priority or 0) + 1

	def validate(self):
		if self.min_amount and self.max_amount and self.min_amount > self.max_amount:
			frappe.throw(_("Min amount cannot be greater than max amount."))

		if self.action == "Create Journal Entry":
			self.validate_contra_accounts()

		for condition in self.conditions:
			if condition.check == "Regex":
				try:
					re.compile(condition.value)
				except re.error:
					frappe.throw(_("Invalid regex pattern: {0}").format(condition.value))

		if self.party and not self.party_type:
			frappe.throw(_("Party Type is required when a Party is set."))

	def validate_contra_accounts(self):
		if self.transaction_type == "Debit":
			self.credit_account = None
			if not self.debit_account:
				frappe.throw(_("Please set the contra account for debit transactions."))
		elif self.transaction_type == "Credit":
			self.debit_account = None
			if not self.credit_account:
				frappe.throw(_("Please set the contra account for credit transactions."))
		else:
			if not self.debit_account and not self.credit_account:
				frappe.throw(
					_("Please set a contra account for debit and/or credit transactions."),
					title=_("Contra Account Missing"),
				)

		for account in (self.debit_account, self.credit_account):
			if not account:
				continue
			account_company, is_group = frappe.get_cached_value(
				"Account", account, ["company", "is_group"]
			)
			if account_company != self.company:
				frappe.throw(_("Account {0} does not belong to company {1}.").format(account, self.company))
			if is_group:
				frappe.throw(_("Account {0} is a group account and cannot be used.").format(account))

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
			filters={"company": self.company, "name": ["!=", self.name]},
			order_by="priority asc",
		)
		for i, rule in enumerate(rules):
			frappe.db.set_value("Demat Transaction Rule", rule.name, "priority", i + 1)

	def evaluate_rule(self, transaction) -> bool:
		"""
		Check whether this rule matches the given transaction. A rule with action
		"Create Journal Entry" only matches lines whose direction has a contra account
		configured, so a debit-only rule falls through for credit lines (and vice versa).
		"""
		if self.company != transaction.company:
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

	def get_contra_account(self, transaction) -> str | None:
		"""The contra ledger account applicable to the transaction's direction."""
		if (transaction.debit or 0) > 0:
			return self.debit_account
		return self.credit_account


@frappe.whitelist(methods=["POST"])
def run_rule_evaluation(force_evaluate: bool = False):
	frappe.has_permission("Demat Transaction", ptype="write", throw=True)
	_run_rule_evaluation(force_evaluate=frappe.utils.sbool(force_evaluate))


def _run_rule_evaluation(force_evaluate=False):
	"""
	Evaluate all rules (by ascending priority; first match wins) against unreconciled
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

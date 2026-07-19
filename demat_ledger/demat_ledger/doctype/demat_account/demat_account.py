# Copyright (c) 2026, Raghav Ruia and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class DematAccount(Document):
	def validate(self):
		self.validate_ledger_account()

	def validate_ledger_account(self):
		account_company, is_group = frappe.get_cached_value(
			"Account", self.account, ["company", "is_group"]
		)

		if account_company != self.company:
			frappe.throw(
				_("The ledger account {0} does not belong to company {1}").format(self.account, self.company)
			)

		if is_group:
			frappe.throw(_("The ledger account cannot be a group account"))

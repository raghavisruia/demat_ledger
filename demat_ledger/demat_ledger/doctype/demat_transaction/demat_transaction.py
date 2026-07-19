# Copyright (c) 2026, Raghav Ruia and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class DematTransaction(Document):
	def before_validate(self):
		if not self.company:
			self.company = frappe.get_cached_value("Demat Account", self.demat_account, "company")

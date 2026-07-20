# Copyright (c) 2026, Raghav Ruia and contributors
# For license information, please see license.txt

"""
Dev utility: wipe all demat ledger transactional data (Journal Entries created by
this app, Demat Transactions, Demat Ledger Import Logs) while keeping Demat
Accounts and Demat Transaction Rules intact.

Run with:
    bench --site <site> execute demat_ledger.dev_cleanup.run
"""

import traceback

import frappe


def run():
	try:
		_run()
	except Exception:
		traceback.print_exc()


def _run():
	je_names = frappe.get_all("Journal Entry", pluck="name")
	for name in je_names:
		je = frappe.get_doc("Journal Entry", name)
		if je.docstatus == 1:
			je.cancel()
		je.delete()
	print("deleted Journal Entries:", len(je_names))

	tx_names = frappe.get_all("Demat Transaction", pluck="name")
	for name in tx_names:
		frappe.delete_doc("Demat Transaction", name, force=True)
	print("deleted Demat Transactions:", len(tx_names))

	log_names = frappe.get_all("Demat Ledger Import Log", pluck="name")
	for name in log_names:
		frappe.delete_doc("Demat Ledger Import Log", name, force=True)
	print("deleted Demat Ledger Import Logs:", len(log_names))

	frappe.db.commit()

	print("remaining Journal Entry:", frappe.db.count("Journal Entry"))
	print("remaining Demat Transaction:", frappe.db.count("Demat Transaction"))
	print("remaining Demat Ledger Import Log:", frappe.db.count("Demat Ledger Import Log"))
	print("remaining Demat Account:", frappe.db.count("Demat Account"))
	print("remaining Demat Transaction Rule:", frappe.db.count("Demat Transaction Rule"))

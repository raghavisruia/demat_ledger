# Copyright (c) 2026, Raghav Ruia and contributors
# For license information, please see license.txt

"""
PDF pipeline smoke test.

Run with:
    bench --site <site> execute demat_ledger.dev_test_pdf.run --kwargs "{'pdf_path': '/path/to/ledger.pdf'}"

Creates a throwaway demat account, imports the PDF through the full Import Log
pipeline (table extraction, page images, column mapping, rule evaluation), prints
the results, and cleans everything up.
"""

import frappe


def run(pdf_path: str):
	with open(pdf_path, "rb") as f:
		content = f.read()

	demat_gl = frappe.db.get_value("Demat Account", "Motilal Oswal - MHDM4434", "account")
	company = frappe.db.get_value("Demat Account", "Motilal Oswal - MHDM4434", "company")

	account = frappe.get_doc(
		{
			"doctype": "Demat Account",
			"account_name": "PDF Pipeline Test",
			"broker_name": "Test Broker",
			"company": company,
			"account": demat_gl,
		}
	).insert()

	file_doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": "pdf_pipeline_test.pdf",
			"is_private": 1,
			"content": content,
		}
	).insert()

	import_log = frappe.get_doc(
		{
			"doctype": "Demat Ledger Import Log",
			"demat_account": account.name,
			"file": file_doc.file_url,
		}
	).insert()

	print("--- PDF detection ---")
	print("tables:", len(import_log.get_pdf_tables()))
	for table in import_log.get_pdf_tables():
		print(
			f"  page {table['page']} header_index={table['header_index']} included={table['included']}"
			f" amount_format={table['amount_format']!r}"
		)
		for column in table["column_mapping"]:
			print(f"    col {column['index']}: {column['header_text']!r} -> {column['maps_to']}")
		print("  page_image:", table.get("page_image"))

	print("transactions:", import_log.number_of_transactions)
	print("period:", import_log.start_date, "to", import_log.end_date)
	print("closing balance:", import_log.closing_balance)
	print("totals: debits", import_log.total_debits, "credits", import_log.total_credits)

	print("\n--- Final transactions ---")
	for transaction in import_log.get_pdf_final_transactions():
		print(
			f"  {transaction['date']} dr={transaction.get('debit')} cr={transaction.get('credit')}"
			f" [{transaction.get('voucher_type')}] {transaction.get('description')!r}"
		)

	import_log.insert_transactions()

	print("\n--- Imported Demat Transactions (with rule evaluation) ---")
	for transaction in frappe.get_all(
		"Demat Transaction",
		filters={"demat_account": account.name},
		fields=["name", "date", "debit", "credit", "voucher_type", "matched_rule", "recommended_account"],
		order_by="date",
	):
		print(
			f"  {transaction.date} dr={transaction.debit} cr={transaction.credit}"
			f" [{transaction.voucher_type}] rule={transaction.matched_rule} -> {transaction.recommended_account}"
		)

	# Clean up the throwaway data.
	frappe.db.delete("Demat Transaction", {"demat_account": account.name})
	import_log.delete()
	account.delete()
	frappe.db.commit()
	print("\nCleaned up test data.")

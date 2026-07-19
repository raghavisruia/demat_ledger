# Copyright (c) 2026, Raghav Ruia and contributors
# For license information, please see license.txt

import json
from datetime import datetime

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate
from frappe.utils.csvutils import read_csv_content
from frappe.utils.xlsxutils import (
	read_xls_file_from_attached_file,
	read_xlsx_file_from_attached_file,
)

from demat_ledger.utils.statement_parser import (
	build_table_transactions,
	compute_final_transactions,
	detect_column_mapping,
	detect_header_row,
	extract_pdf_tables,
	extract_table_in_bbox,
	extract_transaction_rows,
	get_file_properties,
	get_float_amount,
	guess_column_mapping_by_content,
	is_meaningful_mapping,
	render_pdf_pages,
)


class DematLedgerImportLog(Document):
	def before_validate(self):
		self.set_currency()

	def set_currency(self):
		account = frappe.get_cached_value("Demat Account", self.demat_account, "account")
		self.currency = frappe.get_cached_value("Account", account, "account_currency")

	def validate(self):
		for ptype in ("create", "write"):
			if not frappe.has_permission("Demat Transaction", ptype):
				frappe.throw(
					_("You do not have permission to import demat transactions"),
					title=_("Permission Denied"),
				)

		if frappe.get_cached_value("Demat Account", self.demat_account, "disabled"):
			frappe.throw(
				_("The demat account is disabled. Please enable it"), title=_("Disabled Demat Account")
			)

	def before_insert(self):
		if self.is_pdf():
			tables = self.prepare_pdf_tables()
			self.set_pdf_summary(tables)
		else:
			data = self.get_data()
			self.set_file_properties(data)

	def after_insert(self):
		# Page images are attached here (not in before_insert) because the final docname is
		# only assigned after before_insert runs.
		if self.is_pdf():
			self.attach_pdf_page_images()

	def set_file_properties(self, raw_data: list[list]):
		self.detected_header_index, _score = detect_header_row(raw_data)
		self.set_column_mapping_from_columns(detect_column_mapping(raw_data[self.detected_header_index]))
		self.recompute_properties(raw_data)

	def recompute_properties(self, raw_data: list[list]):
		"""
		Recompute everything that depends on the header row and column mapping: transaction
		row range, date/amount format, closing balance and totals. Called both during initial
		detection and after the user overrides the mapping or header row.
		"""
		transaction_rows, starting_index, ending_index = self.get_transaction_rows(raw_data)

		self.detected_transaction_starting_index = starting_index
		self.detected_transaction_ending_index = ending_index
		self.number_of_transactions = len(transaction_rows)

		date_format, amount_format = get_file_properties(transaction_rows)
		self.detected_date_format = date_format
		self.detected_amount_format = amount_format

		self.set_closing_balance(transaction_rows)
		self.set_totals(self.get_final_transactions(transaction_rows))

	def set_totals(self, final_transactions: list):
		total_debits = total_credits = 0
		debit_transactions = credit_transactions = 0

		for transaction in final_transactions:
			debit = transaction.get("debit", 0) or 0
			credit = transaction.get("credit", 0) or 0
			if debit > 0:
				total_debits += debit
				debit_transactions += 1
			if credit > 0:
				total_credits += credit
				credit_transactions += 1

		self.total_debits = total_debits
		self.total_credits = total_credits
		self.total_debit_transactions = debit_transactions
		self.total_credit_transactions = credit_transactions

	def get_file_doc(self):
		return frappe.get_doc("File", {"file_url": self.file})

	def get_file_extension(self):
		return self.get_file_doc().get_extension()[1].lower()

	def is_pdf(self):
		return self.get_file_extension() == ".pdf"

	def get_statement_password(self):
		"""Decrypted PDF password stored on the linked Demat Account (if any)."""
		if not self.demat_account:
			return None

		from frappe.utils.password import get_decrypted_password

		return get_decrypted_password(
			"Demat Account", self.demat_account, "statement_password", raise_exception=False
		)

	def get_data(self):
		"""
		Extract the data from a tabular (CSV/XLSX/XLS) attached file as a list of rows.

		PDFs are not handled here - they go through the multi-table PDF pipeline
		(`prepare_pdf_tables`) since a PDF can yield several tables with differing shapes.
		"""
		file_doc = self.get_file_doc()
		extension = self.get_file_extension()
		content = file_doc.get_content()

		if extension not in (".csv", ".xlsx", ".xls"):
			frappe.throw(
				_("Import file should be of type .csv, .xlsx, .xls or .pdf"),
				title=_("Invalid File Type"),
			)

		if extension == ".csv":
			data = read_csv_content(content)
		elif extension == ".xlsx":
			data = read_xlsx_file_from_attached_file(fcontent=content)
		elif extension == ".xls":
			data = read_xls_file_from_attached_file(content)

		return data

	def set_column_mapping_from_columns(self, columns: list[dict]):
		"""Replace the column_mapping child table from a list of column dicts."""
		self.column_mapping = []

		for col in columns:
			index = col["index"]
			self.append(
				"column_mapping",
				{
					"header_text": col.get("header_text") or _("Column {0}").format(index + 1),
					"variable": col.get("variable") or f"column_{index}",
					"maps_to": col.get("maps_to", "Do not import"),
					"index": index,
				},
			)

	def apply_column_mapping(self, columns: list[dict]):
		"""Persist a user-overridden column mapping and recompute the derived properties."""
		self.set_column_mapping_from_columns(columns)
		self.recompute_properties(self.get_data())

	def apply_header_index(self, header_index: int):
		"""
		Set (or clear, with -1) the header row for a tabular statement.

		The existing column mapping is preserved; it is only re-derived when a header row is
		selected AND that row resolves to a meaningful mapping.
		"""
		raw_data = self.get_data()

		if 0 <= header_index < len(raw_data):
			self.detected_header_index = header_index
			candidate = detect_column_mapping(raw_data[header_index])
			if is_meaningful_mapping(candidate):
				self.set_column_mapping_from_columns(candidate)
		else:
			self.detected_header_index = -1

		self.recompute_properties(raw_data)

	def get_transaction_rows(self, data: list[list]):
		column_mapping: dict[str, int] = {}
		for column in self.column_mapping:
			if column.maps_to != "Do not import":
				column_mapping[column.maps_to] = column.index

		return extract_transaction_rows(data, column_mapping, self.detected_header_index)

	def set_closing_balance(self, transactions: list):
		"""Derive the statement start date, end date and closing balance."""
		statement_start_date = None
		statement_end_date = None
		closing_balance = None

		date_format = self.detected_date_format

		for transaction in transactions:
			date = transaction.get("date")
			if not date:
				continue

			if isinstance(date, datetime):
				tx_date = date
			else:
				tx_date = datetime.strptime(date, date_format)

			if statement_start_date is None or tx_date < statement_start_date:
				statement_start_date = tx_date

			if statement_end_date is None or tx_date >= statement_end_date:
				statement_end_date = tx_date
				closing_balance = transaction.get("balance")

		self.start_date = getdate(statement_start_date) if statement_start_date else None
		self.end_date = getdate(statement_end_date) if statement_end_date else None
		self.closing_balance = get_float_amount(closing_balance)

	def get_final_transactions(self, transaction_rows: list):
		return compute_final_transactions(
			transaction_rows, self.detected_date_format, self.detected_amount_format
		)

	# ------------------------------------------------------------------ #
	# PDF statement handling
	# ------------------------------------------------------------------ #

	def get_pdf_tables(self) -> list[dict]:
		"""The stored per-table PDF extraction data, parsed from the JSON field."""
		if not self.pdf_tables:
			return []
		if isinstance(self.pdf_tables, str):
			return json.loads(self.pdf_tables)
		return self.pdf_tables

	def prepare_pdf_tables(self) -> list[dict]:
		"""
		Extract each table from the PDF (kept separate, never merged), rasterize the
		pages so the user can confirm tables visually, and run a best-effort per-table
		column mapping. The result is stored as JSON on `pdf_tables`.
		"""
		content = self.get_file_doc().get_content()
		password = self.get_statement_password()

		tables = extract_pdf_tables(content, password)

		pages = {table["page"] for table in tables}
		page_images = render_pdf_pages(content, password, pages)

		self.flags._pending_page_images = {page: png for page, (png, _scale) in page_images.items()}
		page_scales = {page: scale for page, (_png, scale) in page_images.items()}

		for table in tables:
			table["page_image"] = None  # filled in after_insert
			table["render_scale"] = page_scales.get(table["page"])

			header_index, score = detect_header_row(table["rows"])
			if score >= 2:
				table["header_index"] = header_index
				table["column_mapping"] = detect_column_mapping(table["rows"][header_index])
			else:
				table["header_index"] = None
				table["column_mapping"] = guess_column_mapping_by_content(table["rows"])

			final_transactions, table["date_format"], table["amount_format"] = build_table_transactions(
				table
			)
			# Tables with no detectable transactions (summaries, headers) start excluded.
			table["included"] = bool(final_transactions)

		self.pdf_tables = json.dumps(tables)
		return tables

	def attach_pdf_page_images(self):
		"""Persist the rendered page images as private Files attached to this log, and
		write their URLs back into `pdf_tables`."""
		pending = getattr(self.flags, "_pending_page_images", None)
		if not pending:
			return

		page_urls = {page: self.save_page_image(png, page) for page, png in pending.items()}

		tables = self.get_pdf_tables()
		for table in tables:
			table["page_image"] = page_urls.get(table["page"])

		self.db_set("pdf_tables", json.dumps(tables), update_modified=False)
		self.flags._pending_page_images = None

	def save_page_image(self, png_bytes: bytes, page_number: int) -> str:
		return (
			frappe.get_doc(
				{
					"doctype": "File",
					"file_name": f"ledger-{self.name}-page-{page_number}.png",
					"is_private": 1,
					"content": png_bytes,
					"attached_to_doctype": self.doctype,
					"attached_to_name": self.name,
				}
			)
			.insert(ignore_permissions=True)
			.file_url
		)

	def get_pdf_final_transactions(self) -> list[dict]:
		"""Union of transactions across all included PDF tables."""
		final_transactions = []
		for table in self.get_pdf_tables():
			if not table.get("included", True):
				continue
			table_transactions, _df, _af = build_table_transactions(table)
			final_transactions.extend(table_transactions)
		return final_transactions

	def set_pdf_summary(self, tables: list[dict]) -> list[dict]:
		"""Compute the doc-level summary fields from the union of included PDF tables."""
		final_transactions = []
		date_format = None
		amount_format = None

		for table in tables:
			if not table.get("included", True):
				continue
			table_transactions, df, af = build_table_transactions(table)
			final_transactions.extend(table_transactions)
			if table_transactions and date_format is None:
				date_format, amount_format = df, af

		self.detected_date_format = date_format or "%d/%m/%Y"
		self.detected_amount_format = amount_format or "Separate columns for debit and credit"
		self.number_of_transactions = len(final_transactions)

		self.set_totals(final_transactions)

		start_date = end_date = None
		closing_balance = None

		for transaction in final_transactions:
			date = transaction.get("date")
			if not date:
				continue
			tx_date = getdate(date)
			if start_date is None or tx_date < start_date:
				start_date = tx_date
			if end_date is None or tx_date >= end_date:
				end_date = tx_date
				closing_balance = transaction.get("balance")

		self.start_date = start_date
		self.end_date = end_date
		self.closing_balance = get_float_amount(closing_balance)

		return final_transactions

	def apply_pdf_tables(self, tables: list[dict]):
		"""Persist the user's per-table edits and recompute the summary."""
		self.pdf_tables = json.dumps(tables)
		self.set_pdf_summary(tables)
		self.save()

	@frappe.whitelist(methods=["POST"])
	def insert_transactions(self):
		if self.status == "Completed":
			return

		demat_account = frappe.get_cached_doc("Demat Account", self.demat_account)

		if demat_account.disabled:
			frappe.throw(
				_("The demat account is disabled. Please enable it"), title=_("Disabled Demat Account")
			)

		currency = frappe.get_cached_value("Account", demat_account.account, "account_currency")

		if self.is_pdf():
			final_transactions = self.get_pdf_final_transactions()
		else:
			raw_data = self.get_data()
			transaction_rows, _start, _end = self.get_transaction_rows(raw_data)
			final_transactions = self.get_final_transactions(transaction_rows)

		total_transactions = len(final_transactions)
		progress = 0

		for transaction in final_transactions:
			demat_tx = frappe.get_doc(
				{
					"doctype": "Demat Transaction",
					"date": transaction.get("date"),
					"status": "Unreconciled",
					"demat_account": self.demat_account,
					"company": demat_account.company,
					"debit": transaction.get("debit"),
					"credit": transaction.get("credit"),
					"balance": transaction.get("balance"),
					"description": transaction.get("description"),
					"voucher_type": transaction.get("voucher_type"),
					"voucher_no": transaction.get("voucher_no"),
					"reference_number": transaction.get("reference"),
					"currency": currency,
					"import_log": self.name,
				}
			)
			demat_tx.insert()
			progress += 1

			frappe.publish_realtime(
				"demat-ledger-import-progress",
				{"progress": round(progress / total_transactions * 100)},
				doctype="Demat Ledger Import Log",
				docname=self.name,
			)

		frappe.publish_realtime(
			"demat-ledger-import-progress",
			{"progress": 100, "total": total_transactions},
			doctype="Demat Ledger Import Log",
			docname=self.name,
		)

		from demat_ledger.demat_ledger.doctype.demat_transaction_rule.demat_transaction_rule import (
			_run_rule_evaluation,
		)

		_run_rule_evaluation()

		self.status = "Completed"
		self.save()


@frappe.whitelist(methods=["GET"])
def get_statement_details(statement_import_id: str):
	doc = frappe.get_doc("Demat Ledger Import Log", statement_import_id)

	doc.check_permission()

	char_map = {
		"%d": "DD",
		"%m": "MM",
		"%Y": "YYYY",
		"%y": "YY",
		"%b": "MMM",
		"%B": "MMMM",
		"%H": "HH",
		"%M": "mm",
		"%S": "ss",
	}
	formatted_date_format = doc.detected_date_format or ""

	for char, replacement in char_map.items():
		formatted_date_format = formatted_date_format.replace(char, replacement)

	conflicting_transactions = check_for_conflicts(doc.demat_account, doc.start_date, doc.end_date)

	if doc.is_pdf():
		return {
			"doc": doc,
			"date_format": formatted_date_format,
			"conflicting_transactions": conflicting_transactions,
			"final_transactions": doc.get_pdf_final_transactions(),
			"raw_data": [],
			"pdf_tables": doc.get_pdf_tables(),
		}

	raw_data = doc.get_data()
	transaction_rows, _start, _end = doc.get_transaction_rows(raw_data)

	return {
		"doc": doc,
		"date_format": formatted_date_format,
		"conflicting_transactions": conflicting_transactions,
		"final_transactions": doc.get_final_transactions(transaction_rows),
		"raw_data": raw_data,
	}


@frappe.whitelist(methods=["POST"])
def update_pdf_tables(statement_import_id: str, tables: list | str):
	"""Persist the user's per-table edits (column mapping, include/exclude flags) for a PDF
	statement and return the refreshed statement details."""
	doc = frappe.get_doc("Demat Ledger Import Log", statement_import_id)
	doc.check_permission("write")

	throw_if_completed(doc)

	if isinstance(tables, str):
		tables = json.loads(tables)

	doc.apply_pdf_tables(tables)

	return get_statement_details(statement_import_id)


@frappe.whitelist(methods=["POST"])
def reextract_pdf_table(statement_import_id: str, page: int, table_index: int, bbox: list | str):
	"""
	Re-extract one PDF table's rows from a user-adjusted bounding box and refresh the preview.
	The user's column mapping is preserved when the column count is unchanged; otherwise the
	table is re-mapped automatically.
	"""
	doc = frappe.get_doc("Demat Ledger Import Log", statement_import_id)
	doc.check_permission("write")

	throw_if_completed(doc)

	if isinstance(bbox, str):
		bbox = json.loads(bbox)

	page = int(page)
	table_index = int(table_index)

	content = doc.get_file_doc().get_content()
	password = doc.get_statement_password()
	rows = extract_table_in_bbox(content, password, page, [float(v) for v in bbox])

	tables = doc.get_pdf_tables()
	for table in tables:
		if table["page"] == page and table["table_index"] == table_index:
			old_columns = max((len(row) for row in table.get("rows", [])), default=0)
			new_columns = max((len(row) for row in rows), default=0)

			table["rows"] = rows
			table["bbox"] = [round(float(v), 2) for v in bbox]

			# Keep the user's mapping if the shape is unchanged; otherwise re-detect.
			if new_columns != old_columns or not table.get("column_mapping"):
				header_index, score = detect_header_row(rows)
				if score >= 2:
					table["header_index"] = header_index
					table["column_mapping"] = detect_column_mapping(rows[header_index])
				else:
					table["header_index"] = None
					table["column_mapping"] = guess_column_mapping_by_content(rows)

			_finals, table["date_format"], table["amount_format"] = build_table_transactions(table)
			break

	doc.apply_pdf_tables(tables)

	return get_statement_details(statement_import_id)


@frappe.whitelist(methods=["POST"])
def set_pdf_table_header(statement_import_id: str, page: int, table_index: int, header_index: int):
	"""
	Set (or clear, with -1) the header row of a PDF table and re-derive its column mapping.
	"""
	doc = frappe.get_doc("Demat Ledger Import Log", statement_import_id)
	doc.check_permission("write")

	throw_if_completed(doc)

	page = int(page)
	table_index = int(table_index)
	header_index = int(header_index)

	tables = doc.get_pdf_tables()
	for table in tables:
		if table["page"] == page and table["table_index"] == table_index:
			rows = table.get("rows", [])
			if 0 <= header_index < len(rows):
				table["header_index"] = header_index
				candidate = detect_column_mapping(rows[header_index])
				if is_meaningful_mapping(candidate):
					table["column_mapping"] = candidate
			else:
				table["header_index"] = None

			_finals, table["date_format"], table["amount_format"] = build_table_transactions(table)
			break

	doc.apply_pdf_tables(tables)

	return get_statement_details(statement_import_id)


@frappe.whitelist(methods=["POST"])
def update_column_mapping(statement_import_id: str, column_mapping: list | str):
	"""Persist a user-overridden column mapping for a tabular (CSV/XLSX) statement."""
	doc = frappe.get_doc("Demat Ledger Import Log", statement_import_id)
	doc.check_permission("write")

	throw_if_completed(doc)

	if isinstance(column_mapping, str):
		column_mapping = json.loads(column_mapping)

	doc.apply_column_mapping(column_mapping)
	doc.save()

	return get_statement_details(statement_import_id)


@frappe.whitelist(methods=["POST"])
def set_header_index(statement_import_id: str, header_index: int):
	"""Set (or clear, with -1) the header row of a tabular statement and re-derive its mapping."""
	doc = frappe.get_doc("Demat Ledger Import Log", statement_import_id)
	doc.check_permission("write")

	throw_if_completed(doc)

	doc.apply_header_index(int(header_index))
	doc.save()

	return get_statement_details(statement_import_id)


def throw_if_completed(doc):
	if doc.status == "Completed":
		frappe.throw(_("This statement has already been imported."), title=_("Already Imported"))


def check_for_conflicts(demat_account: str, start_date, end_date):
	"""Existing demat transactions in the statement's date range - likely duplicates."""
	if not start_date or not end_date:
		return []

	return frappe.get_all(
		"Demat Transaction",
		filters={
			"demat_account": demat_account,
			"date": ["between", [start_date, end_date]],
		},
		fields=[
			"name",
			"date",
			"debit",
			"credit",
			"description",
			"voucher_type",
			"voucher_no",
			"currency",
			"status",
		],
		order_by="date",
	)

# Copyright (c) 2026, Raghav Ruia and contributors
# For license information, please see license.txt

"""
Broker-agnostic ledger statement parser.

Adapted from erpnext's bank statement import pipeline
(erpnext/accounts/doctype/bank_statement_import_log/bank_statement_import_log.py),
with column keywords and amount semantics suited to broker/demat client ledgers:
a statement CREDIT increases your balance with the broker, a DEBIT decreases it.
A single signed Amount column is interpreted as positive = credit, negative = debit.
"""

import io
import re
from datetime import datetime

import frappe
from frappe import _

HEADER_KEYWORDS = [
	"date",
	"amount",
	"narration",
	"description",
	"particulars",
	"voucher",
	"debit",
	"credit",
	"cr",
	"dr",
	"balance",
	"cheque",
	"reference",
	"type",
]

# Order matters: composite variables (Debit/Credit, Voucher Type/No) must be checked
# before the simple ones so e.g. a "Dr/Cr" header is not claimed by "Debit".
STANDARD_VARIABLES = {
	"Debit/Credit": [
		"cr/dr",
		"dr/cr",
		"debit/credit",
		"credit/debit",
		"debit / credit",
		"credit / debit",
		"transaction type",
	],
	"Voucher Type": ["voucher type", "voc type", "vch type"],
	"Voucher No": ["voucher no", "voucher number", "voc no", "vch no"],
	"Date": ["date"],
	"Debit": ["debit", "withdrawal"],
	"Credit": ["credit", "deposit"],
	"Amount": ["amount"],
	"Description": ["narration", "description", "particulars", "remarks", "detail"],
	"Reference": ["cheque", "check", "chq", "reference", "ref no"],
	"Balance": ["balance"],
}

# Map of standard column variable -> transaction row field
FIELD_MAP = {
	"Date": "date",
	"Amount": "amount",
	"Debit": "debit",
	"Credit": "credit",
	"Balance": "balance",
	"Reference": "reference",
	"Description": "description",
	"Debit/Credit": "debit_credit",
	"Voucher Type": "voucher_type",
	"Voucher No": "voucher_no",
}

AMOUNT_FORMATS = [
	"Separate columns for debit and credit",
	'Amount column has "CR"/"DR" values',
	"Amount column has positive/negative values",
	'Transaction type column has "CR"/"DR" values',
	'Transaction type column has "Debit"/"Credit" values',
	'Transaction type column has "C"/"D" values',
]


def detect_header_row(data: list[list]) -> tuple[int, int]:
	"""
	Return ``(row_index, score)`` of the most header-like row. ``score`` is the count of
	cells containing a ledger keyword - callers can treat a low score as "no header".
	"""
	row_index = 0
	max_valid_columns = 0

	for idx, row in enumerate(data):
		valid_columns = 0
		for cell in row:
			if not cell or not isinstance(cell, str):
				continue
			if any(keyword in cell.lower() for keyword in HEADER_KEYWORDS):
				valid_columns += 1
		if valid_columns > max_valid_columns:
			max_valid_columns = valid_columns
			row_index = idx

	return row_index, max_valid_columns


def detect_column_mapping(header_row: list) -> list[dict]:
	"""
	Given a header row, map each column index to a standard variable, or "Do not import".
	A standard variable can be represented by multiple names; the first match wins.
	"""
	column_mapping: dict[str, int] = {}
	columns = []

	for idx, cell in enumerate(header_row):
		if not cell or not isinstance(cell, str):
			continue

		column = {
			"index": idx,
			"header_text": cell,
			"variable": cell.strip().lower().replace(" ", "_").replace("?", "").replace(".", ""),
			"maps_to": "Do not import",
		}

		for standard_variable, names in STANDARD_VARIABLES.items():
			if any(name in cell.lower().replace(".", "") for name in names):
				if column_mapping.get(standard_variable) is None:
					column["maps_to"] = standard_variable
					column_mapping[standard_variable] = idx
					break

		columns.append(column)

	return columns


def is_meaningful_mapping(columns: list[dict]) -> bool:
	"""True if at least one column resolves to an actual field (not "Do not import")."""
	return any(col.get("maps_to") and col["maps_to"] != "Do not import" for col in columns)


def guess_column_mapping_by_content(rows: list[list]) -> list[dict]:
	"""
	Best-effort column mapping for tables without a usable header row (common in PDFs).
	Uses cell contents: a mostly-date column -> Date, the widest text column -> Description,
	and a lone numeric column -> Amount. Ambiguous numeric columns (e.g. separate
	debit/credit/balance) are left for the user to map.
	"""
	num_cols = max((len(row) for row in rows), default=0)
	column_stats = []

	for idx in range(num_cols):
		cells = [row[idx] for row in rows if idx < len(row) and str(row[idx]).strip() != ""]
		count = len(cells)
		if not count:
			column_stats.append({"index": idx, "date_ratio": 0, "num_ratio": 0, "avg_len": 0, "count": 0})
			continue
		date_hits = sum(1 for c in cells if isinstance(c, str) and frappe.utils.guess_date_format(c))
		num_hits = sum(1 for c in cells if get_float_amount(c) is not None)
		avg_len = sum(len(str(c)) for c in cells) / count
		column_stats.append(
			{
				"index": idx,
				"date_ratio": date_hits / count,
				"num_ratio": num_hits / count,
				"avg_len": avg_len,
				"count": count,
			}
		)

	mapping: dict[int, str] = {}
	numeric_cols = []
	date_assigned = False

	for stat in column_stats:
		if stat["count"] == 0:
			continue
		if not date_assigned and stat["date_ratio"] >= 0.6:
			mapping[stat["index"]] = "Date"
			date_assigned = True
		elif stat["num_ratio"] >= 0.6:
			numeric_cols.append(stat["index"])

	# Description: widest non-date, non-numeric text column
	text_cols = [
		s for s in column_stats if s["count"] and s["index"] not in mapping and s["index"] not in numeric_cols
	]
	if text_cols:
		mapping[max(text_cols, key=lambda s: s["avg_len"])["index"]] = "Description"

	# A single numeric column is unambiguously the amount; otherwise leave for the user.
	if len(numeric_cols) == 1:
		mapping[numeric_cols[0]] = "Amount"

	return [
		{
			"index": idx,
			"header_text": "",
			"variable": f"column_{idx}",
			"maps_to": mapping.get(idx, "Do not import"),
		}
		for idx in range(num_cols)
	]


def extract_transaction_rows(data: list[list], column_mapping: dict[str, int], header_index: int):
	"""
	``header_index`` may be -1/None to mean "no header row - treat every row as data"
	(used for headerless PDF tables).

	For each row after the header, validate that the date column holds a date and that at
	least one of amount/debit/credit is a number. Returns
	``(transaction_rows, starting_index, ending_index)``.
	"""
	if header_index is None:
		header_index = -1

	def cell(row, key):
		idx = column_mapping.get(key)
		if idx is None or idx >= len(row):
			return None
		return row[idx]

	transaction_rows = []
	transaction_starting_index = None
	transaction_ending_index = None

	valid_rows = data[header_index + 1 :]

	for row_index, row in enumerate(valid_rows):
		date = cell(row, "Date")
		amount = cell(row, "Amount")
		debit = cell(row, "Debit")
		credit = cell(row, "Credit")

		if not date:
			continue

		if isinstance(date, datetime):
			date = date.strftime("%Y-%m-%d")

		if not isinstance(date, str):
			continue

		if not amount and not debit and not credit:
			continue

		row_date_format = frappe.utils.guess_date_format(date)
		if not row_date_format:
			continue

		if (
			get_float_amount(amount) is None
			and get_float_amount(debit) is None
			and get_float_amount(credit) is None
		):
			continue

		if transaction_starting_index is None:
			transaction_starting_index = row_index
		transaction_ending_index = row_index

		transaction_row = {"date_format": row_date_format}
		for source_field, target_field in FIELD_MAP.items():
			if source_field in column_mapping:
				transaction_row[target_field] = cell(row, source_field)

		transaction_rows.append(transaction_row)

	base_index = header_index + 1
	if transaction_starting_index is not None:
		transaction_starting_index += base_index
	if transaction_ending_index is not None:
		transaction_ending_index += base_index

	return transaction_rows, transaction_starting_index, transaction_ending_index


def compute_final_transactions(transaction_rows: list, date_format: str, amount_format: str) -> list:
	"""Normalize each row: date to ISO, amount split into statement debit/credit."""
	final_transactions = []

	def parse_amount(transaction_row: dict):
		"""Return ``(debit, credit)`` in statement terms (credit increases broker balance)."""
		if amount_format == "Separate columns for debit and credit":
			return get_float_amount(transaction_row.get("debit")), get_float_amount(
				transaction_row.get("credit")
			)

		if amount_format == 'Amount column has "CR"/"DR" values':
			amount = transaction_row.get("amount")
			float_amount = abs(get_float_amount(amount) or 0)
			if "cr" in amount.lower():
				return 0, float_amount
			return float_amount, 0

		if amount_format == "Amount column has positive/negative values":
			amount = get_float_amount(transaction_row.get("amount", "0")) or 0
			if amount > 0:
				return 0, abs(amount)
			return abs(amount), 0

		if amount_format == 'Transaction type column has "CR"/"DR" values':
			transaction_type = transaction_row.get("debit_credit") or ""
			amount = get_float_amount(transaction_row.get("amount", "0")) or 0
			if "cr" in transaction_type.lower():
				return 0, abs(amount)
			return abs(amount), 0

		if amount_format == 'Transaction type column has "Debit"/"Credit" values':
			transaction_type = transaction_row.get("debit_credit") or ""
			amount = get_float_amount(transaction_row.get("amount", "0")) or 0
			if "credit" in transaction_type.lower():
				return 0, abs(amount)
			return abs(amount), 0

		if amount_format == 'Transaction type column has "C"/"D" values':
			transaction_type = (transaction_row.get("debit_credit") or "").lower().strip()
			amount = get_float_amount(transaction_row.get("amount", "0")) or 0
			if transaction_type == "c":
				return 0, abs(amount)
			return abs(amount), 0

		return 0, 0

	for transaction in transaction_rows:
		date = transaction.get("date")

		if isinstance(date, datetime):
			date = date.strftime("%Y-%m-%d")
		else:
			date = datetime.strptime(date, date_format).strftime("%Y-%m-%d")

		debit, credit = parse_amount(transaction)
		final_transactions.append(
			{
				**transaction,
				"date": date,
				"debit": debit,
				"credit": credit,
				"balance": get_float_amount(transaction.get("balance")),
			}
		)

	return final_transactions


def get_file_properties(transactions: list):
	"""
	From the transaction rows, figure out the most common date format and how the
	amount is encoded (separate debit/credit columns, CR/DR suffix, signed amount,
	or a separate transaction-type column).
	"""
	date_format_frequency = {
		"%d/%m/%Y": 0,
	}

	amount_format_frequency = {amount_format: 0 for amount_format in AMOUNT_FORMATS}

	for transaction in transactions:
		date_format = transaction.get("date_format")

		if date_format:
			date_format_frequency[date_format] = date_format_frequency.get(date_format, 0) + 1

		if transaction.get("debit") or transaction.get("credit"):
			amount_format_frequency["Separate columns for debit and credit"] += 1
			continue

		amount = transaction.get("amount")

		if not amount:
			continue

		if isinstance(amount, str) and ("cr" in amount.lower() or "dr" in amount.lower()):
			amount_format_frequency['Amount column has "CR"/"DR" values'] += 1

		debit_credit = (transaction.get("debit_credit") or "").lower()
		if debit_credit:
			if "cr" in debit_credit or "dr" in debit_credit:
				amount_format_frequency['Transaction type column has "CR"/"DR" values'] += 1
			elif "debit" in debit_credit or "credit" in debit_credit:
				amount_format_frequency['Transaction type column has "Debit"/"Credit" values'] += 1
			elif debit_credit.strip() in ("c", "d"):
				amount_format_frequency['Transaction type column has "C"/"D" values'] += 1
		else:
			amount_format_frequency["Amount column has positive/negative values"] += 1

	most_common_date_format = max(date_format_frequency, key=date_format_frequency.get)
	most_common_amount_format = max(amount_format_frequency, key=amount_format_frequency.get)

	return most_common_date_format, most_common_amount_format


def build_table_transactions(table: dict):
	"""
	Run the per-table detection pipeline on a single PDF table dict and return
	``(final_transactions, date_format, amount_format)``. A table whose mapping has no Date
	column (e.g. a summary block) naturally yields zero transactions.
	"""
	column_mapping: dict[str, int] = {}
	for column in table.get("column_mapping", []):
		if column.get("maps_to") and column["maps_to"] != "Do not import":
			column_mapping[column["maps_to"]] = column["index"]

	transaction_rows, _start, _end = extract_transaction_rows(
		table.get("rows", []), column_mapping, table.get("header_index")
	)
	date_format, amount_format = get_file_properties(transaction_rows)
	final_transactions = compute_final_transactions(transaction_rows, date_format, amount_format)
	return final_transactions, date_format, amount_format


def _clean_cell(cell) -> str:
	"""Normalize a pdfplumber cell: None -> '', collapse wrapped newlines, strip."""
	if cell is None:
		return ""
	return str(cell).replace("\n", " ").strip()


def extract_pdf_tables(content: bytes, password: str | None = None) -> list[dict]:
	"""
	Extract tables from a PDF, kept SEPARATE (never merged), each with its page, table index,
	bounding box and page dimensions. Raises a recognizable error for encrypted PDFs without
	a valid password, and for PDFs where no tables can be detected (e.g. scanned/image PDFs).
	"""
	try:
		import pdfplumber
	except ImportError:
		frappe.throw(
			_("PDF statement support requires the 'pdfplumber' library to be installed."),
			title=_("Missing Dependency"),
		)

	from pypdf import PdfReader

	reader = PdfReader(io.BytesIO(content))
	if reader.is_encrypted:
		if not password:
			password = ""
		if not reader.decrypt(password):
			frappe.throw(
				_(
					"This PDF is password protected. Please set the correct statement password on the"
					" Demat Account and try again."
				),
				title=_("Password Required"),
			)

	text_settings = {"vertical_strategy": "text", "horizontal_strategy": "text"}
	tables = []

	with pdfplumber.open(io.BytesIO(content), password=password or "") as pdf:
		for page_number, page in enumerate(pdf.pages, start=1):
			found_tables = page.find_tables()
			if not found_tables:
				found_tables = page.find_tables(table_settings=text_settings)

			for table_index, table in enumerate(found_tables):
				rows = [[_clean_cell(c) for c in row] for row in (table.extract() or [])]
				rows = [row for row in rows if any(cell != "" for cell in row)]
				if not rows:
					continue

				tables.append(
					{
						"page": page_number,
						"table_index": table_index,
						"bbox": [round(float(v), 2) for v in table.bbox],
						"page_width": round(float(page.width), 2),
						"page_height": round(float(page.height), 2),
						"rows": rows,
					}
				)

	if not tables:
		frappe.throw(
			_(
				"Could not detect any tables in this PDF. It may be a scanned or image-based"
				" statement, which is not supported (no OCR)."
			),
			title=_("No Tables Detected"),
		)

	return tables


def extract_table_in_bbox(
	content: bytes, password: str | None, page_number: int, bbox: list[float]
) -> list[list[str]]:
	"""
	Re-extract a single table from a user-adjusted region (PDF points, top-left origin) on a
	given 1-based page. The bbox is clamped to the page bounds before cropping.
	"""
	import pdfplumber

	text_settings = {"vertical_strategy": "text", "horizontal_strategy": "text"}

	with pdfplumber.open(io.BytesIO(content), password=password or "") as pdf:
		page = pdf.pages[page_number - 1]

		x0 = max(0, min(float(bbox[0]), page.width))
		top = max(0, min(float(bbox[1]), page.height))
		x1 = max(x0 + 1, min(float(bbox[2]), page.width))
		bottom = max(top + 1, min(float(bbox[3]), page.height))

		cropped = page.crop((x0, top, x1, bottom))
		table = cropped.extract_table() or cropped.extract_table(table_settings=text_settings)

	rows = [[_clean_cell(cell) for cell in row] for row in (table or [])]
	return [row for row in rows if any(cell != "" for cell in row)]


def render_pdf_pages(
	content: bytes, password: str | None, pages: set[int], resolution: int = 150
) -> dict[int, tuple[bytes, float]]:
	"""
	Rasterize the requested (1-based) pages to PNG bytes. Returns
	``{page_number: (png_bytes, render_scale)}`` where ``render_scale`` is pixels per PDF point.
	"""
	import pdfplumber

	images = {}
	with pdfplumber.open(io.BytesIO(content), password=password or "") as pdf:
		for page_number, page in enumerate(pdf.pages, start=1):
			if page_number not in pages:
				continue
			page_image = page.to_image(resolution=resolution)
			buffer = io.BytesIO()
			page_image.original.save(buffer, format="PNG")
			images[page_number] = (buffer.getvalue(), round(resolution / 72.0, 4))
	return images


def get_float_amount(amount):
	if amount is None or amount == "":
		return None

	if isinstance(amount, str):
		amount = amount.lower().replace(",", "").replace(" ", "").replace("cr", "").replace("dr", "")
		# Remove any other alphabets and currency symbols - do not remove the minus or decimal sign
		amount = re.sub(r"[^\d.-]", "", amount)
		try:
			amount = float(amount)
		except ValueError:
			return None
	else:
		try:
			amount = float(amount)
		except (ValueError, TypeError):
			return None

	return amount

# Demat Ledger

Broker-agnostic demat/broker ledger import and Journal Entry automation for ERPNext,
modeled on the `/banking` bank reconciliation module. Upload your broker's ledger
report (PDF/CSV/XLSX), let keyword rules recommend the contra ledger per line, review
and bulk-create Journal Entries — the demat account's GL ledger is always one leg.

## Concepts

| DocType | Purpose |
|---|---|
| **Demat Account** | Broker account master: broker name, client code, company, the linked GL **Ledger Account**, and an optional encrypted PDF password. |
| **Demat Ledger Import Log** | One upload. Auto-detects the header row, column mapping, date format and amount format (signed amount, CR/DR suffix, separate debit/credit columns, …). PDFs go through `pdfplumber` table extraction with page previews and per-table column mapping. |
| **Demat Transaction** | One parsed ledger line: date, debit/credit (statement terms), narration, broker voucher type/no, running balance, plus the rule recommendation and the created Journal Entry link. |
| **Demat Transaction Rule** | Priority-ordered matching rules. Conditions (OR'd) match on **Narration** or **Broker Voucher Type** via Contains / Starts With / Ends With / Regex, optionally filtered by direction and amount range. Action is either **Create Journal Entry** or **Ignore** (e.g. opening-balance rows). |

### Direction-aware contra ledgers

A rule can carry **two contra accounts** — one used when the line is a statement
*debit*, one when it is a *credit*. A single "TRADE BILL" rule can therefore post
buys and sells to different ledgers. If a line's direction has no account configured,
the rule does not match and evaluation falls through to the next rule by priority.

### Accounting convention

A statement **credit** (your balance with the broker goes up) **debits** the demat
GL ledger and credits the contra account; a statement **debit** does the reverse.
One submitted Journal Entry is created per line, with the narration and broker
voucher no carried into the remark/reference fields.

## Usage

1. In the Desk, create a **Demat Account** (link it to a GL ledger account).
2. Open **`/demat`** in the browser.
3. **Import Ledger** → pick the account, upload the broker's PDF/CSV/XLSX,
   review the detected mapping (adjust columns / header row / PDF table regions),
   then import.
4. Rules run automatically after import. Review recommendations in the grid,
   override any contra ledger inline, select rows and **Create Journal Entries**.
5. Manage rules via the **Rules** button; **Run Rules** re-evaluates everything
   unreconciled. Use the row **Undo** action to cancel a created JE and start over.

## Whitelisted APIs

- `demat_ledger.api.get_demat_accounts`
- `demat_ledger.api.get_transactions`
- `demat_ledger.api.bulk_create_journal_entries`
- `demat_ledger.api.mark_transactions_ignored`
- `demat_ledger.api.reset_transaction`
- `demat_ledger.api.update_transaction_recommendation`
- `demat_ledger.demat_ledger.doctype.demat_ledger_import_log.demat_ledger_import_log.*`
  (`get_statement_details`, `update_column_mapping`, `set_header_index`,
  `update_pdf_tables`, `reextract_pdf_table`, `set_pdf_table_header`)
- `demat_ledger.demat_ledger.doctype.demat_transaction_rule.demat_transaction_rule.run_rule_evaluation`

## Frontend development

The SPA lives in `frontend/` (Vite + React 19, copied from erpnext's banking app —
same UI kit, jotai + frappe-react-sdk).

```bash
cd apps/demat_ledger/frontend
yarn install
yarn dev    # dev server on :8080, proxies to the bench
yarn build  # outputs to demat_ledger/public/frontend and copies www/demat.html
```

## Dev utilities

```bash
# Seed demo company data, rules, and run a full CSV import + JE creation:
bench --site <site> execute demat_ledger.dev_seed.run

# Smoke-test the PDF pipeline against any ledger PDF (creates + cleans up its own data):
bench --site <site> execute demat_ledger.dev_test_pdf.run --kwargs "{'pdf_path': '/path/to/ledger.pdf'}"
```

## Installation

```bash
bench get-app demat_ledger <this repo>
bench --site <site> install-app demat_ledger
cd apps/demat_ledger/frontend && yarn install && yarn build
```

Requires erpnext (uses its `pdfplumber`/`pypdf` dependencies and `get_default_cost_center`).

## License

MIT

import { DematLedgerImportLog } from "@/types/DematLedger"
import { useFrappeGetCall, useFrappePostCall } from "frappe-react-sdk"

const IMPORT_LOG_API =
    "demat_ledger.demat_ledger.doctype.demat_ledger_import_log.demat_ledger_import_log"

export type ColumnMapsTo =
    | "Do not import"
    | "Date"
    | "Debit"
    | "Credit"
    | "Amount"
    | "Debit/Credit"
    | "Description"
    | "Voucher Type"
    | "Voucher No"
    | "Reference"
    | "Balance"

export type ColumnMappingEntry = {
    index: number
    maps_to: ColumnMapsTo | string
    header_text?: string
    variable?: string
}

/** Apply a column mapping change, clearing the same mapping from any other column. */
export function applyColumnMappingChange<T extends ColumnMappingEntry>(
    columns: T[],
    columnIndex: number,
    mapsTo: ColumnMapsTo,
): T[] {
    const previous = columns.find((c) => c.index === columnIndex)
    const cleared =
        mapsTo === "Do not import"
            ? columns
            : columns.map((c) =>
                  c.index !== columnIndex && c.maps_to === mapsTo
                      ? { ...c, maps_to: "Do not import" as ColumnMapsTo }
                      : c,
              )

    return [
        ...cleared.filter((c) => c.index !== columnIndex),
        {
            index: columnIndex,
            maps_to: mapsTo,
            header_text: previous?.header_text ?? "",
            variable: previous?.variable ?? `column_${columnIndex}`,
        } as T,
    ].sort((a, b) => a.index - b.index)
}

export const COLUMN_MAPS_TO_OPTIONS: ColumnMapsTo[] = [
    "Do not import",
    "Date",
    "Description",
    "Voucher Type",
    "Voucher No",
    "Reference",
    "Debit",
    "Credit",
    "Amount",
    "Balance",
    "Debit/Credit",
]

export interface PDFTableColumn {
    index: number
    header_text: string
    variable?: string
    maps_to: ColumnMapsTo
}

export interface PDFTable {
    page: number
    table_index: number
    bbox: [number, number, number, number]
    page_width: number
    page_height: number
    page_image: string | null
    render_scale: number | null
    rows: string[][]
    header_index: number | null
    column_mapping: PDFTableColumn[]
    date_format?: string
    amount_format?: string
    included: boolean
}

export interface GetStatementDetailsResponse {
    doc: DematLedgerImportLog,
    conflicting_transactions: Array<{
        name: string,
        date: string,
        debit: number,
        credit: number,
        description: string,
        voucher_type: string,
        voucher_no: string,
        currency: string,
        status: string,
    }>,
    final_transactions: Array<{
        date: string,
        debit: number,
        credit: number,
        balance?: number,
        description: string,
        reference: string,
        voucher_type?: string,
        voucher_no?: string,
        debit_credit?: string,
    }>,
    date_format: string,
    raw_data: Array<Array<string>>,
    currency: string,
    pdf_tables?: PDFTable[],
}

export const useGetStatementDetails = (id: string) => {
    return useFrappeGetCall<{ message: GetStatementDetailsResponse }>(`${IMPORT_LOG_API}.get_statement_details`, {
        statement_import_id: id,
    }, undefined, {
        revalidateOnFocus: false
    })

}

export const useUpdatePDFTables = () => {
    return useFrappePostCall<{ message: GetStatementDetailsResponse }>(`${IMPORT_LOG_API}.update_pdf_tables`)
}

export const useReextractPDFTable = () => {
    return useFrappePostCall<{ message: GetStatementDetailsResponse }>(`${IMPORT_LOG_API}.reextract_pdf_table`)
}

export const useSetPDFTableHeader = () => {
    return useFrappePostCall<{ message: GetStatementDetailsResponse }>(`${IMPORT_LOG_API}.set_pdf_table_header`)
}

export const useUpdateColumnMapping = () => {
    return useFrappePostCall<{ message: GetStatementDetailsResponse }>(`${IMPORT_LOG_API}.update_column_mapping`)
}

export const useSetHeaderIndex = () => {
    return useFrappePostCall<{ message: GetStatementDetailsResponse }>(`${IMPORT_LOG_API}.set_header_index`)
}

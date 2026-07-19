import DematAccountPicker from "@/components/common/DematAccountPicker"
import { selectedDematAccountAtom } from "@/state/atoms"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import ErrorBanner from "@/components/ui/error-banner"
import { FileDropzone } from "@/components/ui/file-dropzone"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { H3, Paragraph } from "@/components/ui/typography"
import { formatDate } from "@/lib/date"
import { flt, formatCurrency } from "@/lib/numbers"
import _ from "@/lib/translate"
import { cn } from "@/lib/utils"
import { DematLedgerImportLog } from "@/types/DematLedger"
import { useFrappeCreateDoc, useFrappeFileUpload, useFrappeGetDocList, useFrappeUpdateDoc } from "frappe-react-sdk"
import { useAtomValue } from "jotai"
import { ListIcon, Loader2Icon } from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router"


const Importer = () => {

    const selectedAccount = useAtomValue(selectedDematAccountAtom)

    const [files, setFiles] = useState<File[]>([])
    const [password, setPassword] = useState("")

    const { upload, error, loading } = useFrappeFileUpload()

    const navigate = useNavigate()
    const { createDoc, loading: createLoading, error: createError } = useFrappeCreateDoc<DematLedgerImportLog>()
    const { updateDoc, error: updateError } = useFrappeUpdateDoc()

    const isPdf = files[0]?.name?.toLowerCase().endsWith(".pdf") ?? false

    const onUpload = () => {

        if (!selectedAccount) {
            return
        }

        const id = `new-demat-ledger-import-log-${Date.now()}`

        // For protected PDFs, persist the password on the Demat Account so it is reused for
        // every ledger of this account (and is available before the import doc is created).
        const ensurePassword = isPdf && password
            ? updateDoc("Demat Account", selectedAccount.name, { statement_password: password })
            : Promise.resolve()

        ensurePassword.then(() => upload(files[0], {
            isPrivate: true,
            doctype: "Demat Ledger Import Log",
            docname: id,
            fieldname: 'file'
        })).then((file) => {
            return createDoc("Demat Ledger Import Log",
                // @ts-expect-error - not filling everything else
                {
                    name: id,
                    file: file.file_url,
                    demat_account: selectedAccount.name
                })
        }).then((doc) => {
            navigate(`/import/${doc.name}`)
        })
    }

    return (
        <div className="flex px-4">
            <div className="w-[52%]">
                {error && <ErrorBanner error={error} />}
                {createError && <ErrorBanner error={createError} />}
                {updateError && <ErrorBanner error={updateError} />}
                <div className="py-2 flex flex-col gap-6">
                    <div className="flex flex-col gap-2">
                        <Label>{_("Demat Account")}<span className="text-ink-red-3">*</span></Label>
                        <div className="min-w-56 w-fit flex flex-col">
                            <DematAccountPicker />
                        </div>
                    </div>
                    {selectedAccount && <div className="flex flex-col gap-4 pe-4">
                        <div className="flex justify-between">
                            <div className="flex flex-col gap-2">
                                <Label>{_("Broker Ledger File")}<span className="text-ink-red-3">*</span></Label>
                                <p
                                    data-slot="form-description"
                                    className={cn("text-ink-gray-5 text-xs")}
                                >
                                    {_("Upload your broker's ledger report to start the import process. We support CSV, XLSX and PDF files.")}
                                </p>
                            </div>
                            <div>
                                <StatementInstructions />
                            </div>
                        </div>

                        <FileDropzone
                            setFiles={setFiles}
                            files={files}
                            className="p-8"
                            accept={{
                                'text/csv': ['.csv'],
                                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
                                'application/vnd.ms-excel': ['.xls'],
                                'application/pdf': ['.pdf'],
                            }}
                            multiple={false}
                        />

                        {isPdf && <div className="flex flex-col gap-2">
                            <Label htmlFor="pdf-password">{_("PDF Password")}</Label>
                            <Input
                                id="pdf-password"
                                type="password"
                                autoComplete="off"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder={_("Only if the PDF is password protected")}
                                className="max-w-sm"
                            />
                            <p data-slot="form-description" className={cn("text-ink-gray-5 text-p-sm")}>
                                {_("Leave blank to use the password already saved for this demat account (if any). It is stored encrypted and reused for future ledgers.")}
                            </p>
                        </div>}
                    </div>}
                    <div className="flex justify-end px-4">
                        <Button
                            onClick={onUpload}
                            size='md'
                            disabled={files.length === 0 || loading || createLoading || !selectedAccount}>
                            {loading || createLoading ? <Loader2Icon className="size-4 animate-spin" /> : null}
                            {loading || createLoading ? _("Uploading...") : _("Upload")}
                        </Button>
                    </div>
                </div>
            </div>
            <div className="w-[48%] border-s border-outline-gray-2 ps-4">
                {selectedAccount && <PreviousImports />}
            </div>

        </div>
    )
}

const StatementInstructions = () => {
    return <Dialog>
        <DialogTrigger asChild>
            <Button variant='outline' size='sm'>{_("View Instructions")}</Button>
        </DialogTrigger>
        <DialogContent className="min-w-7xl">
            <DialogHeader>
                <DialogTitle>{_("Ledger Import Instructions")}</DialogTitle>
                <DialogDescription>{_("We support uploading CSV, XLSX, XLS and PDF files. Please make sure the file contains the correct columns.")}</DialogDescription>
            </DialogHeader>
            <Paragraph className="text-sm">{_("The file should contain the following columns with a distinct header row. You can upload most broker ledger reports as is without changing the columns.")}</Paragraph>
            <Paragraph className="text-sm text-ink-gray-6">{_("For PDF ledgers, we auto-detect the tables on each page. You can then confirm each detected table, map its columns, and exclude anything that is not transactions (e.g. summaries). Password-protected PDFs are supported - the password is saved on the demat account and reused.")}</Paragraph>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>{_("Column Name")}</TableHead>
                        <TableHead>{_("Maps To")}</TableHead>
                        <TableHead>{_("Description")}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    <TableRow>
                        <TableCell>Date/Voc Date/Transaction Date</TableCell>
                        <TableCell>{_("Date")}</TableCell>
                        <TableCell className="text-ink-gray-5">{_("The date of the transaction")}</TableCell>
                    </TableRow>
                    <TableRow>
                        <TableCell>Amount</TableCell>
                        <TableCell>{_("Amount")}</TableCell>
                        <TableCell className="text-ink-gray-5">{_('This can contain "CR"/"DR" values or positive/negative values (positive = credit). You could also have a separate column for CR/DR.')}</TableCell>
                    </TableRow>
                    <TableRow>
                        <TableCell>Debit/Credit</TableCell>
                        <TableCell>{_("Debit")}/{_("Credit")}</TableCell>
                        <TableCell className="text-ink-gray-5">{_("Separate debit and credit amount columns - only required if there's no amount column.")}</TableCell>
                    </TableRow>
                    <TableRow>
                        <TableCell>Voucher Type</TableCell>
                        <TableCell>{_("Voucher Type")}</TableCell>
                        <TableCell className="text-ink-gray-5">{_("The broker's voucher type (e.g. TRADE BILL, PAYOUT, Journal Voucher). Matching rules can key on this.")}</TableCell>
                    </TableRow>
                    <TableRow>
                        <TableCell>Voucher No</TableCell>
                        <TableCell>{_("Voucher No")}</TableCell>
                        <TableCell className="text-ink-gray-5">{_("The broker's voucher number")}</TableCell>
                    </TableRow>
                    <TableRow>
                        <TableCell>Narration/Description/Particulars/Remarks</TableCell>
                        <TableCell>{_("Description")}</TableCell>
                        <TableCell className="text-ink-gray-5">{_("The narration of the transaction. Matching rules can key on this.")}</TableCell>
                    </TableRow>
                    <TableRow>
                        <TableCell>Cheque No/Reference</TableCell>
                        <TableCell>{_("Reference")}</TableCell>
                        <TableCell className="text-ink-gray-5">{_("The reference or cheque number of the transaction")}</TableCell>
                    </TableRow>
                    <TableRow>
                        <TableCell>Balance</TableCell>
                        <TableCell>{_("Balance")}</TableCell>
                        <TableCell className="text-ink-gray-5">{_("The running balance as per the broker's ledger")}</TableCell>
                    </TableRow>
                </TableBody>
            </Table>
            <DialogFooter>
                <DialogClose asChild>
                    <Button variant='outline'>{_("Close")}</Button>
                </DialogClose>
            </DialogFooter>
        </DialogContent>
    </Dialog>
}

const PreviousImports = () => {

    const dematAccount = useAtomValue(selectedDematAccountAtom)

    const { data, error } = useFrappeGetDocList<DematLedgerImportLog>("Demat Ledger Import Log", {
        fields: ["name", "file", "status", "number_of_transactions", "start_date", "end_date", "closing_balance", "creation"],
        filters: [["demat_account", "=", dematAccount?.name ?? ""]],
        orderBy: {
            field: "creation",
            order: "desc"
        },
        limit: 10
    }, dematAccount ? undefined : null, {
        revalidateOnFocus: false
    })

    const navigate = useNavigate()

    const onViewDetails = (name: string) => {
        navigate(`/import/${name}`)
    }

    return (
        <div className="flex flex-col gap-4">
            <H3 className="text-base">{_("Previous Imports")}</H3>

            {error && <ErrorBanner error={error} />}

            {data && data.length > 0 ? (

                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{_("Imported On")}</TableHead>
                            <TableHead>{_("Status")}</TableHead>
                            <TableHead>{_("Transaction Dates")}</TableHead>
                            <TableHead className="text-end">{_("Number of Transactions")}</TableHead>
                            <TableHead className="text-end">{_("Closing Balance")}</TableHead>
                            <TableHead>{_("File")}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {data?.map((item) => (
                            <TableRow key={item.name} onClick={() => onViewDetails(item.name)} className="cursor-pointer hover:bg-surface-gray-2">
                                <TableCell>{formatDate(item.creation, 'Do MMM YYYY')}</TableCell>
                                <TableCell><Badge theme={item.status === "Completed" ? "green" : "gray"}>{item.status}</Badge></TableCell>
                                <TableCell>
                                    {item.start_date && item.end_date ? (
                                        <span>{formatDate(item.start_date, 'Do MMM YYYY')} to {formatDate(item.end_date, 'Do MMM YYYY')}</span>
                                    ) : (
                                        <span>-</span>
                                    )}
                                </TableCell>
                                <TableCell className="text-end">{item.number_of_transactions}</TableCell>
                                <TableCell className="text-end font-numeric">{formatCurrency(flt(item.closing_balance, 2))}</TableCell>
                                <TableCell><a
                                    href={item.file}
                                    target="_blank" className="underline underline-offset-4">{item.file.split('/').pop()}</a></TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>)
                : <Empty>
                    <EmptyHeader>
                        <EmptyMedia>
                            <ListIcon />
                        </EmptyMedia>
                        <EmptyTitle>{_("No broker ledgers imported yet")}</EmptyTitle>
                    </EmptyHeader>
                </Empty>}
        </div>
    )
}
export default Importer

import { lazy } from 'react'
import { useGetStatementDetails } from '@/components/features/Importer/import_utils'
import { Button } from '@/components/ui/button'
import { useDirection } from '@/components/ui/direction'
import ErrorBanner from '@/components/ui/error-banner'
import _ from '@/lib/translate'
import { useFrappeDocumentEventListener } from 'frappe-react-sdk'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { Link, useParams } from 'react-router'

const CSVImport = lazy(() => import('@/components/features/Importer/CSV/CSVImport'))
const PDFImport = lazy(() => import('@/components/features/Importer/PDF/PDFImport'))

const ViewImportLog = () => {

    const { id } = useParams<{ id: string }>()

    const { data, isLoading, error, mutate } = useGetStatementDetails(id ?? "")

    useFrappeDocumentEventListener("Demat Ledger Import Log", id ?? "", () => {
    })

    const direction = useDirection()

    if (isLoading) {
        return <div className='p-4'>{_("Loading...")}</div>
    }

    if (error) {
        return <div className='flex flex-col gap-4 px-4'>
            <div>
                <Button size='sm' variant='outline' asChild>
                    <Link to="/import">
                        {direction === 'ltr' ? <ChevronLeftIcon /> : <ChevronRightIcon />}
                        {_("Back")}
                    </Link>
                </Button>
            </div>
            <ErrorBanner error={error} />
        </div>
    }

    if (!data || !data.message) {
        return null
    }

    const isPdf = data.message.doc.file?.toLowerCase().endsWith('.pdf')

    if (isPdf) {
        return <PDFImport data={data} mutate={mutate} />
    }

    return <CSVImport data={data} mutate={mutate} />
}

export default ViewImportLog

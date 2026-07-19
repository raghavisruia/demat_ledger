import { lazy, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { FrappeProvider } from 'frappe-react-sdk'
import { Toaster } from '@/components/ui/sonner'
import Home from '@/pages/Home'
import ImporterContainer from '@/pages/ImporterContainer'
import { TooltipProvider } from './components/ui/tooltip'
import { LucideProvider } from 'lucide-react'
import { ThemeProvider } from './components/ui/theme-provider'

const Importer = lazy(() => import('@/pages/Importer'))
const ViewImportLog = lazy(() => import('@/pages/ViewImportLog'))

function App() {
	useEffect(() => {
		// Check if user is logged in by checking the Cookie "user_id"
		// In Frappe, unauthenticated users are "Guest"
		const userId = document.cookie?.split('; ').find(row => row.startsWith('user_id='))?.split('=')[1]?.trim()
		const isLoggedIn = userId !== 'Guest'

		if (!isLoggedIn) {
			if (import.meta.env.DEV) {
				return
			}
			// Redirect to Frappe login page
			window.location.href = '/login?redirect-to=/demat'
			return
		}
	}, [])

	return (
		<LucideProvider
			strokeWidth={1.5}
		>
			<TooltipProvider>
				<FrappeProvider
					swrConfig={{
						errorRetryCount: 2
					}}
					socketPort={import.meta.env.VITE_SOCKET_PORT}
					siteName={window.frappe?.boot?.sitename ?? import.meta.env.VITE_SITE_NAME}>
					<ThemeProvider
						defaultTheme={window.frappe?.boot?.desk_theme ?? "Automatic"}
					>
						{window.frappe?.boot?.user?.name && window.frappe?.boot?.user?.name !== 'Guest' &&
							<BrowserRouter basename={import.meta.env.VITE_BASE_NAME ? `/${import.meta.env.VITE_BASE_NAME}` : ''}>
								<Routes>
									<Route index element={<Home />} />
									<Route path="/import" element={<ImporterContainer />}>
										<Route index element={<Importer />} />
										<Route path=":id" element={<ViewImportLog />} />
									</Route>
									<Route path="*" element={<Navigate to="/" />} />
								</Routes>
							</BrowserRouter>
						}
						<Toaster richColors />
					</ThemeProvider>
				</FrappeProvider>
			</TooltipProvider>
		</LucideProvider>
	)
}

export default App

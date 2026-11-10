/** Shared document shell and global styles for the two application journeys. */
import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Student Support | Welfare Assistant', description: 'A simulated student support assistant and staff review queue.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

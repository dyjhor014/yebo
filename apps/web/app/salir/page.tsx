import type { Metadata } from 'next';
import { SignOut } from './sign-out';

export const metadata: Metadata = { title: 'Cerrar sesión · YEBO', robots: { index: false } };

export default function SignOutPage() {
  return <SignOut />;
}

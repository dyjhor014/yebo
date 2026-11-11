import type { Metadata } from 'next';
import { InvitationFlow } from './invitation-flow';

export const metadata: Metadata = {
  title: 'Invitación · YEBO',
  robots: { index: false },
  referrer: 'no-referrer',
};

export default function InvitationPage() {
  return <InvitationFlow />;
}
